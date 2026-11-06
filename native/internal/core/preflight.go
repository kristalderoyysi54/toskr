package core

import (
	"regexp"
	"slices"
	"strings"
	"sync"
	"unicode/utf16"
	"unicode/utf8"
)

// Finding 是发送前预检命中的一处敏感内容（字节区间）。Category 用 Tauri FindingCategory 名：
// privateKey | authorization | apiKey | databaseUrl | cookie | session 为高风险（始终检测），
// email | phone | nationalId | bankCard | ipAddress 为提示级（可在设置里关）；custom = 用户自定义的敏感字段（按高风险处理）。
type Finding struct {
	Kind       string
	Category   string
	Rule       string
	Start, End int
}

// WarnCategories 同 Tauri FIREWALL_WARN_CATEGORIES（顺序即设置里的显示顺序）。
var WarnCategories = []string{"email", "phone", "nationalId", "bankCard", "ipAddress"}

// CategoryLabel 同 Tauri FIREWALL_CATEGORY_LABEL。
var CategoryLabel = map[string]string{
	"privateKey": "私钥", "authorization": "授权凭据", "apiKey": "密钥/凭据", "databaseUrl": "数据库连接",
	"email": "邮箱", "phone": "手机号", "nationalId": "身份证号", "bankCard": "银行卡号", "ipAddress": "IP 地址",
	"cookie": "Cookie", "session": "会话标识",
}

// Rules 是用户的隐私检查设置（同 Tauri firewallEnabled / firewallDisabledWarnCategories / firewallCustomSensitiveFields）。
type Rules struct {
	Off          bool
	DisabledWarn []string
	CustomFields []string
}

// Preflight 用默认规则扫描（全部类别开启、无自定义字段）。
func Preflight(text string) []Finding { return Scan(text, Rules{}) }

// Scan 在发送前扫描文本（同 Tauri scan_sensitive_text_with_rules + 前端按类别过滤）：高风险与自定义字段始终检测，
// 提示级类别按设置开关；关掉隐私检查（Off）或文本超过 2MB 时不报。
func Scan(text string, r Rules) []Finding {
	if r.Off || len(text) > maxScanBytes {
		return nil
	}
	cs := collect(text)
	if re := customFieldRe(r.CustomFields); re != nil {
		for _, m := range re.FindAllStringSubmatchIndex(text, -1) {
			raw := text[m[4]:m[5]]
			v := trimQuotes(raw)
			if v == "" || isPlaceholder(v, true) {
				continue
			}
			s := m[4] + len(raw) - len(strings.TrimLeft(raw, `'"`))
			cs = append(cs, candidate{cat: "custom", rule: "token.custom_sensitive_field", block: true, start: s, end: s + len(v),
				u16: len(utf16.Encode([]rune(v))), name: strings.TrimSpace(text[m[2]:m[3]])})
		}
	}
	var out []Finding
	for _, c := range resolveOverlaps(cs) {
		if slices.Contains(r.DisabledWarn, c.cat) {
			continue
		}
		kind := CategoryLabel[c.cat]
		if c.cat == "custom" {
			kind = "自定义敏感字段：" + c.name
		}
		out = append(out, Finding{Kind: kind, Category: c.cat, Rule: c.rule, Start: c.start, End: c.end})
	}
	return out
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
