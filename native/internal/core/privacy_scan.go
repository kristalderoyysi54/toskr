package core

//go:generate python3 -I gen_privacy_patterns.py

import (
	"encoding/base64"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"
)

// 本文件逐条移植 Tauri src-tauri/src/privacy.rs 的 collect_candidates / resolve_overlaps（含 context.rs、providers.rs）：
// 正则原文由 gen_privacy_patterns.py 从 Rust 源码抽出（privacy_patterns_gen.go），校验函数照 Rust 版改写。
// 差异：Go RE2 的 \b、\s 只认 ASCII（Rust 默认 Unicode），对中英混排的命中边界影响很小。

const maxScanBytes = 2 * 1024 * 1024 // 同 Tauri MAX_SCAN_INPUT_BYTES：超限不做不完整扫描

type candidate struct {
	cat, rule  string
	block      bool
	start, end int
	u16        int
	name       string // 自定义字段名
}

var (
	reMu    sync.Mutex
	reCache = map[string]*regexp.Regexp{}
)

func tre(name string) *regexp.Regexp {
	reMu.Lock()
	defer reMu.Unlock()
	if re, ok := reCache[name]; ok {
		return re
	}
	re := regexp.MustCompile(tauriPatterns[name])
	reCache[name] = re
	return re
}

type validator func(text, v string, start, end int, re *regexp.Regexp, m []int) bool

func always(string, string, int, int, *regexp.Regexp, []int) bool { return true }

func group(re *regexp.Regexp, m []int, name string) (int, int, bool) {
	i := re.SubexpIndex(name)
	if i < 0 || m[2*i] < 0 {
		return 0, 0, false
	}
	return m[2*i], m[2*i+1], true
}

func isPlaceholder(s string, custom bool) bool {
	if custom {
		return tre("CUSTOM_REDACTION_PLACEHOLDER_RE").MatchString(s)
	}
	return tre("REDACTION_PLACEHOLDER_RE").MatchString(s)
}

func trimQuotes(s string) string { return strings.Trim(s, `'"`) }

func trimMatch(text string, start, end int) (int, int) {
	for start < end {
		r, n := utf8.DecodeRuneInString(text[start:end])
		if !unicode.IsSpace(r) && r != '\'' && r != '"' {
			break
		}
		start += n
	}
	for start < end {
		r, n := utf8.DecodeLastRuneInString(text[start:end])
		if !unicode.IsSpace(r) && !strings.ContainsRune(`'".,;)]}`, r) {
			break
		}
		end -= n
	}
	return start, end
}

// add 同 Rust add_capture_candidates：取 secret 组（无则整段）、豁免脱敏占位符、裁掉包裹的引号与尾随标点后交给校验。
func add(out *[]candidate, text, cell, cat, rule string, block bool, secret bool, valid validator) {
	re := tre(cell)
	for _, m := range re.FindAllStringSubmatchIndex(text, -1) {
		s, e := m[0], m[1]
		if secret {
			var ok bool
			if s, e, ok = group(re, m, "secret"); !ok {
				s, e = m[0], m[1]
			}
		}
		raw := text[s:e]
		if rule == "credential.context_password" {
			if isPlaceholder(unquote(raw), true) {
				continue
			}
			v := unquote(raw)
			if len(v) != len(raw) {
				s++
			}
			e = s + len(v)
		} else {
			if isPlaceholder(trimQuotes(strings.TrimRight(strings.TrimSpace(raw), ",;.)}")), false) {
				continue
			}
			s, e = trimMatch(text, s, e)
		}
		if s >= e {
			continue
		}
		if v := text[s:e]; valid(text, v, s, e, re, m) {
			*out = append(*out, candidate{cat: cat, rule: rule, block: block, start: s, end: e, u16: len(utf16.Encode([]rune(v)))})
		}
	}
}

func unquote(v string) string {
	if len(v) >= 2 && (v[0] == '\'' || v[0] == '"') && v[len(v)-1] == v[0] {
		return v[1 : len(v)-1]
	}
	return v
}

func isTok(r rune, dot bool) bool {
	return r < 128 && (unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' || (dot && r == '.'))
}

func boundary(text string, start, end int, dot bool) bool {
	if r, _ := utf8.DecodeLastRuneInString(text[:start]); start > 0 && isTok(r, dot) {
		return false
	}
	if r, _ := utf8.DecodeRuneInString(text[end:]); end < len(text) && isTok(r, dot) {
		return false
	}
	return true
}

func nontrivial(_ string, v string, _, _ int, _ *regexp.Regexp, _ []int) bool {
	if utf8.RuneCountInString(v) < 12 {
		return false
	}
	switch strings.ToLower(v) {
	case "placeholder", "your_api_key", "your_secret", "example_value", "disabled":
		return false
	}
	return true
}

func bearer(_ string, v string, _, _ int, _ *regexp.Regexp, _ []int) bool {
	return utf8.RuneCountInString(v) >= 8
}

func basicSecret(_ string, v string, _, _ int, _ *regexp.Regexp, _ []int) bool {
	b, err := base64.StdEncoding.DecodeString(v)
	if err != nil {
		if b, err = base64.RawStdEncoding.DecodeString(v); err != nil {
			return false
		}
	}
	i := slices.Index(b, ':')
	return i > 0 && i+1 < len(b)
}

func pemBlock(text, v string, _, _ int, re *regexp.Regexp, m []int) bool {
	bs, be, ok1 := group(re, m, "begin")
	es, ee, ok2 := group(re, m, "end")
	return v != "" && ok1 == ok2 && (!ok1 || text[bs:be] == text[es:ee])
}

func jwtToken(_ string, v string, _, _ int, _ *regexp.Regexp, _ []int) bool {
	parts := strings.Split(v, ".")
	if len(parts) != 3 || parts[2] == "" {
		return false
	}
	h, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || !utf8.Valid(h) {
		return false
	}
	return strings.HasPrefix(strings.TrimLeftFunc(string(h), unicode.IsSpace), "{") && strings.Contains(string(h), `"alg"`)
}

func envSecret(_ string, v string, _, _ int, _ *regexp.Regexp, _ []int) bool {
	if utf8.RuneCountInString(v) < 8 {
		return false
	}
	lower := strings.ToLower(v)
	switch lower {
	case "placeholder", "required", "optional", "changeme", "change_me", "your_password", "your_api_key", "your_secret", "example_value", "disabled", "redacted":
		return false
	}
	if strings.HasPrefix(v, "${") || strings.HasPrefix(v, "$(") || strings.HasPrefix(v, "<") || strings.HasPrefix(v, "%") {
		return false
	}
	if (strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://")) && !strings.Contains(v, "@") {
		return false
	}
	if (strings.HasPrefix(v, "/") || strings.HasPrefix(v, "./") || strings.HasPrefix(v, "~/")) && strings.Contains(v[1:], "/") {
		return false
	}
	return true
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return false
		}
	}
	return true
}

func validEmail(v string) bool {
	local, domain, ok := strings.Cut(v, "@")
	if !ok {
		return false
	}
	tld := domain[strings.LastIndex(domain, ".")+1:]
	return !strings.HasPrefix(local, ".") && !strings.HasSuffix(local, ".") && !strings.Contains(local, "..") && len(tld) >= 2
}

func digitsOf(v string) []byte {
	var d []byte
	for i := 0; i < len(v); i++ {
		if v[i] >= '0' && v[i] <= '9' {
			d = append(d, v[i])
		}
	}
	return d
}

func parseIPv4(s string) bool {
	parts := strings.Split(s, ".")
	for _, p := range parts {
		if n, err := strconv.ParseUint(p, 10, 8); err != nil || n > 255 {
			return false
		}
	}
	return len(parts) == 4
}

func validDate(y, m, d int) bool {
	return y >= 1800 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m)
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

// validPhone 同 Tauri valid_phone：7–15 位数字、不全相同、不是日期也不是 IP。
func validPhone(v string) bool {
	d := digitsOf(v)
	if len(d) < 7 || len(d) > 15 || parseIPv4(v) {
		return false
	}
	for _, sep := range []string{"-", ".", "/"} {
		if p := strings.Split(v, sep); len(p) == 3 && len(p[0]) == 4 && len(p[1]) <= 2 && len(p[2]) <= 2 {
			y, e1 := strconv.Atoi(p[0])
			mo, e2 := strconv.Atoi(p[1])
			da, e3 := strconv.Atoi(p[2])
			if e1 == nil && e2 == nil && e3 == nil && validDate(y, mo, da) {
				return false
			}
		}
	}
	return slices.ContainsFunc(d, func(b byte) bool { return b != d[0] })
}

func validMainlandID(v string) bool {
	u := strings.ToUpper(v)
	if len(u) != 18 {
		return false
	}
	for i := 0; i < 17; i++ {
		if u[i] < '0' || u[i] > '9' {
			return false
		}
	}
	y, _ := strconv.Atoi(u[6:10])
	m, _ := strconv.Atoi(u[10:12])
	d, _ := strconv.Atoi(u[12:14])
	if !validDate(y, m, d) || u[14:17] == "000" {
		return false
	}
	weights := []int{7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2}
	sum := 0
	for i, w := range weights {
		sum += int(u[i]-'0') * w
	}
	return u[17] == "10X98765432"[sum%11]
}

func luhnValid(v string) bool {
	d := digitsOf(v)
	if len(d) < 13 || len(d) > 19 || !slices.ContainsFunc(d, func(b byte) bool { return b != d[0] }) {
		return false
	}
	sum := 0
	for i := range d {
		x := int(d[len(d)-1-i] - '0')
		if i%2 == 1 {
			if x *= 2; x > 9 {
				x -= 9
			}
		}
		sum += x
	}
	return sum%10 == 0
}

var (
	sshCmdRe  = regexp.MustCompile(`(?:^|[\s;|&])(?:ssh|scp|sftp|rsync|ssh-copy-id)[ \t]+(?:(?:-[pPilJoF][ \t]+[^\s;|&]+|-[A-Za-z]+)[ \t]+)*$`)
	copyCmdRe = regexp.MustCompile(`(?:^|[;|&])[ \t]*(?:scp|rsync)[ \t]+[^\r\n;|&]*$`)
)

// tailFrom：prefix 里倒数第 n+1 个字符的起点（同 Rust char_indices().rev().nth(n)），不足取 0。
func tailFrom(prefix string, n int) int {
	i := len(prefix)
	for k := 0; k <= n; k++ {
		if i == 0 {
			return 0
		}
		_, sz := utf8.DecodeLastRuneInString(prefix[:i])
		i -= sz
	}
	return i
}

// emailIsRemoteTarget 同 Tauri context::email_is_remote_target：ssh:// URL、git@host:repo、紧跟 ssh/scp 命令的目标不算邮箱。
func emailIsRemoteTarget(text string, start, end int) bool {
	prefix, suffix := text[:start], text[end:]
	if strings.HasSuffix(prefix, "ssh://") {
		return true
	}
	if strings.HasPrefix(text[start:end], "git@") && strings.HasPrefix(suffix, ":") {
		if r, _ := utf8.DecodeRuneInString(suffix[1:]); len(suffix) > 1 && !unicode.IsSpace(r) {
			return true
		}
	}
	p := prefix[tailFrom(prefix, 128):]
	return sshCmdRe.MatchString(p) ||
		((strings.HasPrefix(suffix, ":/") || strings.HasPrefix(suffix, ":~/") || strings.HasPrefix(suffix, ":./")) && copyCmdRe.MatchString(p))
}

func businessNumberContext(text string, start int) bool {
	prefix := text[:start]
	return tre("LABEL").MatchString(prefix[tailFrom(prefix, 96):])
}

var passwordWords = []string{"null", "none", "true", "false", "required", "optional", "changeme", "change_me", "placeholder", "your_password", "redacted",
	"未设置", "不需要", "字符串", "空的", "空", "无", "一个字符串", "必填字段"}

// collect 同 Rust collect_candidates（含 context::collect 与 providers::collect），顺序不影响结果（之后统一消解重叠）。
func collect(text string) []candidate {
	var out []candidate
	block := func(cell, cat, rule string, valid validator) { add(&out, text, cell, cat, rule, true, true, valid) }
	warn := func(cell, cat, rule string, valid validator) { add(&out, text, cell, cat, rule, false, true, valid) }

	add(&out, text, "PEM_RE", "privateKey", "credential.pem_private_key", true, false, pemBlock)
	block("AUTH_BEARER_HEADER_RE", "authorization", "auth.authorization_header_bearer", bearer)
	block("AUTH_BASIC_HEADER_RE", "authorization", "auth.authorization_header_basic", basicSecret)
	block("AUTH_TOKEN_HEADER_RE", "authorization", "auth.authorization_header_token", bearer)
	block("BEARER_RE", "authorization", "auth.bearer", bearer)
	block("BASIC_RE", "authorization", "auth.basic", basicSecret)
	block("API_KEY_RE", "apiKey", "token.contextual_secret", nontrivial)
	block("API_KEY_ZH_RE", "apiKey", "token.contextual_secret_zh", nontrivial)
	block("LABELED_APP_CREDENTIAL_RE", "apiKey", "token.labeled_app_credential", func(t, v string, s, e int, re *regexp.Regexp, m []int) bool {
		return isASCII(v) && envSecret(t, v, s, e, re, m)
	})
	add(&out, text, "DATABASE_URL_RE", "databaseUrl", "credential.database_url", true, false, always)
	warn("EMAIL_RE", "email", "contact.email", func(t, v string, s, e int, _ *regexp.Regexp, _ []int) bool {
		return validEmail(v) && !emailIsRemoteTarget(t, s, e)
	})
	warn("PHONE_RE", "phone", "contact.phone_context", func(_, v string, _, _ int, _ *regexp.Regexp, _ []int) bool { return validPhone(v) })
	warn("NATIONAL_ID_RE", "nationalId", "identity.cn_mainland_id", func(t, v string, s, e int, _ *regexp.Regexp, _ []int) bool {
		return boundary(t, s, e, false) && validMainlandID(v)
	})
	warn("NATIONAL_ID_CONTEXT_RE", "nationalId", "identity.cn_mainland_id_context", func(t, v string, s, e int, _ *regexp.Regexp, _ []int) bool {
		return boundary(t, s, e, false) && strings.ContainsFunc(v, func(r rune) bool { return byte(r) != v[0] })
	})
	warn("BANK_CARD_RE", "bankCard", "financial.bank_card_luhn", func(_, v string, _, _ int, _ *regexp.Regexp, _ []int) bool { return luhnValid(v) })
	ip := tre("IPV4_RE")
	for _, m := range ip.FindAllStringSubmatchIndex(text, -1) {
		s, e, ok := group(ip, m, "secret")
		if !ok || !boundary(text, s, e, true) || !parseIPv4(text[s:e]) {
			continue
		}
		rule := "network.ipv4_public"
		if privateIPv4(text[s:e]) {
			rule = "network.ipv4_private"
		}
		out = append(out, candidate{cat: "ipAddress", rule: rule, start: s, end: e, u16: e - s})
	}
	for _, p := range [][2]string{
		{"AWS_ACCESS_KEY_RE", "token.provider_aws_access_key_id"}, {"GITHUB_TOKEN_RE", "token.provider_github"},
		{"GITLAB_TOKEN_RE", "token.provider_gitlab"}, {"SLACK_TOKEN_RE", "token.provider_slack"},
		{"SLACK_WEBHOOK_RE", "token.provider_slack_webhook"}, {"STRIPE_KEY_RE", "token.provider_stripe"},
		{"GOOGLE_API_KEY_RE", "token.provider_google_api_key"}, {"ANTHROPIC_KEY_RE", "token.provider_anthropic"},
		{"OPENAI_KEY_RE", "token.provider_openai"}, {"NPM_TOKEN_RE", "token.provider_npm"},
		{"TELEGRAM_BOT_RE", "token.provider_telegram_bot"},
	} {
		block(p[0], "apiKey", p[1], always)
	}
	block("ENV_SECRET_RE", "apiKey", "token.env_sensitive_field", envSecret)
	block("JWT_RE", "authorization", "credential.jwt", jwtToken)
	block("COOKIE_HEADER_RE", "cookie", "session.cookie_header", nontrivial)
	block("COOKIE_FIELD_RE", "cookie", "session.cookie_field", nontrivial)
	block("SESSION_FIELD_RE", "session", "session.explicit_field", nontrivial)

	// context.rs
	lower := strings.ToLower(text)
	if slices.ContainsFunc([]string{"password", "passwd", "pwd", "密码", "口令"}, func(w string) bool { return strings.Contains(lower, w) }) {
		block("PASSWORD", "apiKey", "credential.context_password", func(_, v string, _, _ int, _ *regexp.Regexp, _ []int) bool {
			return v != "" && !tre("TEMPLATE").MatchString(v) && !slices.Contains(passwordWords, strings.ToLower(v))
		})
	}
	warn("PHONE", "phone", "contact.phone_cn_unlabeled", func(t, v string, s, e int, _ *regexp.Regexp, _ []int) bool {
		return boundary(t, s, e, true) && !businessNumberContext(t, s) && validPhone(v)
	})
	warn("CARD", "bankCard", "financial.bank_card_unlabeled", func(t, v string, s, e int, _ *regexp.Regexp, _ []int) bool {
		return boundary(t, s, e, true) && !businessNumberContext(t, s) && !validMainlandID(v) && luhnValid(v)
	})

	// providers.rs：关键词预筛 + 两侧不能接 token 字符或 -、=
	for _, p := range []struct {
		cell, rule string
		dot        bool
		kw         []string
	}{
		{"ALIBABA_RE", "token.alibaba_access_key_id", false, []string{"ltai"}},
		{"CLOUDFLARE_TOKEN_RE", "token.cloudflare_api_token", false, []string{"cloudflare", "cf"}},
		{"CLOUDFLARE_GLOBAL_RE", "token.cloudflare_global_api_key", false, []string{"cloudflare", "cf"}},
		{"CLOUDFLARE_ORIGIN_RE", "token.cloudflare_origin_ca_key", false, []string{"v1.0-"}},
		{"HUGGINGFACE_RE", "token.huggingface", false, []string{"hf_", "api_org_"}},
		{"DIGITALOCEAN_RE", "token.digitalocean", false, []string{"dop_v1_", "doo_v1_", "dor_v1_"}},
		{"SENDGRID_RE", "token.sendgrid", true, []string{"sg."}},
	} {
		if !slices.ContainsFunc(p.kw, func(w string) bool { return strings.Contains(lower, w) }) {
			continue
		}
		dot := p.dot
		block(p.cell, "apiKey", p.rule, func(t, _ string, s, e int, _ *regexp.Regexp, _ []int) bool {
			return boundary(t, s, e, dot) && !strings.HasSuffix(t[:s], "-") && !strings.HasPrefix(t[e:], "-") && !strings.HasPrefix(t[e:], "=")
		})
	}
	return out
}

func privateIPv4(s string) bool {
	p := strings.Split(s, ".")
	a, _ := strconv.Atoi(p[0])
	b, _ := strconv.Atoi(p[1])
	return a == 10 || a == 127 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168) || (a == 169 && b == 254)
}

// resolveOverlaps 同 Rust：高风险优先 → 更长优先 → 规则名 → 起点；重叠的后来者丢弃，结果按位置排序。
func resolveOverlaps(cs []candidate) []candidate {
	sort.SliceStable(cs, func(i, j int) bool {
		a, b := cs[i], cs[j]
		if a.block != b.block {
			return a.block
		}
		if a.u16 != b.u16 {
			return a.u16 > b.u16
		}
		if a.rule != b.rule {
			return a.rule < b.rule
		}
		return a.start < b.start
	})
	var acc []candidate
	for _, c := range cs {
		if !slices.ContainsFunc(acc, func(x candidate) bool { return x.start < c.end && c.start < x.end }) {
			acc = append(acc, c)
		}
	}
	sort.SliceStable(acc, func(i, j int) bool {
		a, b := acc[i], acc[j]
		if a.start != b.start {
			return a.start < b.start
		}
		if a.end != b.end {
			return a.end < b.end
		}
		return a.rule < b.rule
	})
	return acc
}
