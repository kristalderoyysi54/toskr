package core

import (
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"
)

// Finding 是发送前预检命中的一处敏感内容（字节区间）。Category 为空 = 高风险（密钥 / 凭据，始终检测）；
// 其余是提示级类别 email | phone | nationalId | bankCard | ipAddress（同 Tauri FIREWALL_WARN_CATEGORIES，可在设置里关），
// custom = 用户自定义的敏感字段（按高风险处理）。
type Finding struct {
	Kind       string
	Category   string
	Start, End int
}

// WarnCategories 同 Tauri FIREWALL_WARN_CATEGORIES（顺序即设置里的显示顺序）。
var WarnCategories = []string{"email", "phone", "nationalId", "bankCard", "ipAddress"}

var CategoryLabel = map[string]string{"email": "邮箱", "phone": "手机号", "nationalId": "身份证号", "bankCard": "银行卡号", "ipAddress": "IP 地址"}

// Rules 是用户的隐私检查设置（同 Tauri firewallEnabled / firewallDisabledWarnCategories / firewallCustomSensitiveFields）。
type Rules struct {
	Off          bool
	DisabledWarn []string
	CustomFields []string
}

var secretPatterns = []struct {
	kind string
	re   *regexp.Regexp
}{
	{"私钥", regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----`)},
	{"AWS 密钥", regexp.MustCompile(`\bAKIA[0-9A-Z]{16}\b`)},
	{"GitHub 令牌", regexp.MustCompile(`\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b`)},
	{"API 密钥", regexp.MustCompile(`\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}`)},
	{"Slack 令牌", regexp.MustCompile(`\bxox[abprs]-[A-Za-z0-9-]{10,}`)},
	{"Google API 密钥", regexp.MustCompile(`\bAIza[0-9A-Za-z_-]{35}\b`)},
	{"JWT", regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`)},
	{"密码字段", regexp.MustCompile(`(?i)\b(?:password|passwd|pwd|secret|token)\s*[:=]\s*\S{6,}`)},
}

var (
	cardRe  = regexp.MustCompile(`\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}(?:[ -]?\d{1,3})?\b`)
	idRe    = regexp.MustCompile(`\b\d{17}[\dXx]\b`)
	emailRe = regexp.MustCompile(`(?i)\b[A-Z0-9.!#$%&'*+/=?^_` + "`" + `{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)*\.[A-Z]{2,}\b`)
	// 手机号：只认带「电话 / 手机 / phone / tel / mobile」上下文的号码（同 Tauri contact.phone_context；「订单号 138…」不算）
	phoneCtxRe = regexp.MustCompile(`(?i)(?:\b(?:phone|tel(?:ephone)?|mobile)(?:[ \t._-]*number)?\b|(?:电话|手机|联系电话)(?:号码|号)?)["']?[ \t]*[:：=]?[ \t]*["']?(\+?[0-9][0-9() .\-]{5,22}[0-9])`)
	ipv4Re     = regexp.MustCompile(`(?:[0-9]{1,3}\.){3}[0-9]{1,3}`)
	sshCmdRe   = regexp.MustCompile(`(?:^|[\s;|&])(?:ssh|scp|sftp|rsync|ssh-copy-id)[ \t]+(?:(?:-[pPilJoF][ \t]+[^\s;|&]+|-[A-Za-z]+)[ \t]+)*$`)
)

// Preflight 用默认规则扫描（全部类别开启、无自定义字段）。
func Preflight(text string) []Finding { return Scan(text, Rules{}) }

// Scan 在发送前扫描文本：高风险（密钥、令牌、私钥、密码字段、自定义敏感字段）始终检测；提示级类别按设置开关。
// 关掉隐私检查（Off）时什么都不报。对应 Tauri privacy.rs scan_sensitive_text_with_rules 的文本部分。
func Scan(text string, r Rules) []Finding {
	if r.Off {
		return nil
	}
	on := func(cat string) bool { return !slices.Contains(r.DisabledWarn, cat) }
	var out []Finding
	for _, p := range secretPatterns {
		for _, m := range p.re.FindAllStringIndex(text, -1) {
			out = append(out, Finding{p.kind, "", m[0], m[1]})
		}
	}
	if re := customFieldRe(r.CustomFields); re != nil {
		for _, m := range re.FindAllStringSubmatchIndex(text, -1) {
			name := strings.TrimSpace(text[m[2]:m[3]])
			out = append(out, Finding{"自定义敏感字段：" + name, "custom", m[4], m[5]})
		}
	}
	if on("bankCard") {
		for _, m := range cardRe.FindAllStringIndex(text, -1) {
			if luhn(text[m[0]:m[1]]) {
				out = append(out, Finding{"银行卡号", "bankCard", m[0], m[1]})
			}
		}
	}
	if on("nationalId") {
		for _, m := range idRe.FindAllStringIndex(text, -1) {
			if idChecksum(text[m[0]:m[1]]) {
				out = append(out, Finding{"身份证号", "nationalId", m[0], m[1]})
			}
		}
	}
	if on("email") {
		for _, m := range emailRe.FindAllStringIndex(text, -1) {
			if !emailIsRemoteTarget(text, m[0], m[1]) {
				out = append(out, Finding{"邮箱", "email", m[0], m[1]})
			}
		}
	}
	if on("phone") {
		for _, m := range phoneCtxRe.FindAllStringSubmatchIndex(text, -1) {
			if validPhone(text[m[2]:m[3]]) {
				out = append(out, Finding{"手机号", "phone", m[2], m[3]})
			}
		}
	}
	if on("ipAddress") {
		for _, m := range ipv4Re.FindAllStringIndex(text, -1) {
			if tokenBoundary(text, m[0], m[1]) && validIPv4(text[m[0]:m[1]]) {
				out = append(out, Finding{"IP 地址", "ipAddress", m[0], m[1]})
			}
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Start < out[j].Start })
	return dedupe(out)
}

// dedupe：同一区间（或被前一处完全覆盖）只留一处（上下文手机号与裸手机号会重叠）。
func dedupe(fs []Finding) []Finding {
	var out []Finding
	for _, f := range fs {
		if n := len(out); n > 0 && f.Start >= out[n-1].Start && f.End <= out[n-1].End {
			continue
		}
		out = append(out, f)
	}
	return out
}

func validIPv4(s string) bool {
	parts := strings.Split(s, ".")
	for _, p := range parts {
		if n, err := strconv.Atoi(p); err != nil || n > 255 {
			return false
		}
	}
	return len(parts) == 4
}

// tokenBoundary 同 Tauri token_boundary(dot_is_token=true)：前后紧邻不能是字母数字、下划线或点（「version1.2.3.4beta」不算 IP）。
func tokenBoundary(text string, start, end int) bool {
	tok := func(r rune) bool {
		return r < 128 && (r == '_' || r == '.' || unicode.IsLetter(r) || unicode.IsDigit(r))
	}
	if r, _ := utf8.DecodeLastRuneInString(text[:start]); start > 0 && tok(r) {
		return false
	}
	if r, _ := utf8.DecodeRuneInString(text[end:]); end < len(text) && tok(r) {
		return false
	}
	return true
}

// validPhone 同 Tauri valid_phone：7–15 位数字、不全相同、不是日期（2026-08-11）也不是 IP。
func validPhone(v string) bool {
	var digits []byte
	for i := 0; i < len(v); i++ {
		if v[i] >= '0' && v[i] <= '9' {
			digits = append(digits, v[i])
		}
	}
	if len(digits) < 7 || len(digits) > 15 || validIPv4(v) {
		return false
	}
	for _, sep := range []string{"-", ".", "/"} {
		if p := strings.Split(v, sep); len(p) == 3 && len(p[0]) == 4 && len(p[1]) <= 2 && len(p[2]) <= 2 {
			y, e1 := strconv.Atoi(p[0])
			mo, e2 := strconv.Atoi(p[1])
			d, e3 := strconv.Atoi(p[2])
			if e1 == nil && e2 == nil && e3 == nil && y >= 1800 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo) {
				return false
			}
		}
	}
	return slices.ContainsFunc(digits, func(b byte) bool { return b != digits[0] })
}

func daysIn(y, m int) int {
	switch m {
	case 2:
		if y%4 == 0 && (y%100 != 0 || y%400 == 0) {
			return 29
		}
		return 28
	case 4, 6, 9, 11:
		return 30
	}
	return 31
}

// emailIsRemoteTarget 同 Tauri context::email_is_remote_target：ssh:// URL、git@host:repo、紧跟 ssh/scp 命令的目标不算邮箱。
func emailIsRemoteTarget(text string, start, end int) bool {
	prefix, suffix := text[:start], text[end:]
	if strings.HasSuffix(prefix, "ssh://") {
		return true
	}
	if strings.HasPrefix(text[start:end], "git@") && len(suffix) > 1 && suffix[0] == ':' && !unicode.IsSpace(rune(suffix[1])) {
		return true
	}
	from := max(0, len(prefix)-128)
	for from > 0 && !utf8.RuneStart(prefix[from]) {
		from++
	}
	return sshCmdRe.MatchString(prefix[from:])
}

var (
	fieldNameRe = regexp.MustCompile(`^[A-Za-z0-9\p{Han}_.-]+$`)
	customCache = struct {
		key string
		re  *regexp.Regexp
	}{}
	customMu sync.Mutex
)

// CustomFieldIssue 同 Tauri customSensitiveFieldIssue：空、过长、含非法字符、重复（英文不区分大小写）、超过 32 个。
func CustomFieldIssue(v string, existing []string) string {
	f := strings.TrimSpace(v)
	switch {
	case f == "":
		return "请填写字段名，不需要填写密钥值"
	case utf8.RuneCountInString(f) > 64:
		return "字段名最多 64 个字符"
	case !fieldNameRe.MatchString(f):
		return "仅支持汉字、英文字母、数字、下划线、点和短横线，不含空格"
	case slices.ContainsFunc(existing, func(x string) bool { return strings.EqualFold(x, f) }):
		return "这个字段已经添加（英文不区分大小写）"
	case len(existing) >= 32:
		return "最多添加 32 个敏感字段"
	}
	return ""
}

// customFieldRe 同 Tauri CustomSensitiveRules：「字段名[（说明）][:：= 或空白]值」，捕获字段名与值；字段两侧不能延伸成另一个字段。
func customFieldRe(fields []string) *regexp.Regexp {
	if len(fields) == 0 {
		return nil
	}
	key := strings.Join(fields, "\x00")
	customMu.Lock()
	defer customMu.Unlock()
	if customCache.key == key {
		return customCache.re
	}
	names := make([]string, 0, len(fields))
	for _, f := range fields {
		if CustomFieldIssue(f, nil) == "" {
			names = append(names, regexp.QuoteMeta(strings.TrimSpace(f)))
		}
	}
	var re *regexp.Regexp
	if len(names) > 0 {
		re = regexp.MustCompile(`(?i)(?:^|[^\p{L}\p{N}_.-])(` + strings.Join(names, "|") + `)["']?(?:[ \t]*[（(][^\r\n）)]*[）)])?(?:[ \t]*[:：=][ \t]*|[ \t]+)("[^"\r\n]+"|'[^'\r\n]+'|[^\s"'<>，,;；}]+)`)
	}
	customCache.key, customCache.re = key, re
	return re
}

func luhn(s string) bool {
	var digits []int
	for _, r := range s {
		if r >= '0' && r <= '9' {
			digits = append(digits, int(r-'0'))
		}
	}
	if len(digits) < 15 {
		return false
	}
	sum := 0
	for i := range digits {
		d := digits[len(digits)-1-i]
		if i%2 == 1 {
			if d *= 2; d > 9 {
				d -= 9
			}
		}
		sum += d
	}
	return sum%10 == 0
}

func idChecksum(s string) bool {
	weights := []int{7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2}
	sum := 0
	for i, w := range weights {
		sum += int(s[i]-'0') * w
	}
	want := "10X98765432"[sum%11]
	got := s[17]
	if got == 'x' {
		got = 'X'
	}
	return got == want
}

// Redact 用 • 遮住命中区间（保留首尾各 2 个字符），供「遮罩后发送」。
func Redact(text string, fs []Finding) string {
	b := []byte(text)
	last := 0
	var out []byte
	for _, f := range fs {
		if f.Start < last {
			continue
		}
		out = append(out, b[last:f.Start]...)
		seg := []rune(string(b[f.Start:f.End]))
		for i, r := range seg {
			if i < 2 || i >= len(seg)-2 {
				out = append(out, string(r)...)
			} else {
				out = append(out, "•"...)
			}
		}
		last = f.End
	}
	return string(append(out, b[last:]...))
}
