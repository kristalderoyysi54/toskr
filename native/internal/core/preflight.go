package core

import (
	"regexp"
	"sort"
)

// Finding 是发送前预检命中的一处敏感内容（字节区间）。
type Finding struct {
	Kind       string
	Start, End int
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
	cardRe = regexp.MustCompile(`\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}(?:[ -]?\d{1,3})?\b`)
	idRe   = regexp.MustCompile(`\b\d{17}[\dXx]\b`)
)

// Preflight 在发送前扫描文本里的密钥、令牌、银行卡号（Luhn 校验）与身份证号（校验位），
// 命中时由调用方要求二次确认。对应 Tauri 版发送预检的文本部分。
func Preflight(text string) []Finding {
	var out []Finding
	for _, p := range secretPatterns {
		for _, m := range p.re.FindAllStringIndex(text, -1) {
			out = append(out, Finding{p.kind, m[0], m[1]})
		}
	}
	for _, m := range cardRe.FindAllStringIndex(text, -1) {
		if luhn(text[m[0]:m[1]]) {
			out = append(out, Finding{"银行卡号", m[0], m[1]})
		}
	}
	for _, m := range idRe.FindAllStringIndex(text, -1) {
		if idChecksum(text[m[0]:m[1]]) {
			out = append(out, Finding{"身份证号", m[0], m[1]})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Start < out[j].Start })
	return out
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
