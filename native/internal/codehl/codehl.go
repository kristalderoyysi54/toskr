// Package codehl 是卡片代码识别与着色（同 Tauri src/lib/code.ts：detectCode 评分 + 12 种语言高亮）。
// Tauri 用 highlight.js 自动识别；这里用结构特征挑语言，着色只分关键字 / 字符串 / 数字 / 注释四类。
package codehl

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

var (
	reImport   = regexp.MustCompile(`(?m)^#!/|^\s*(import|from|package|use|using)\s+\S`)
	reDecl     = regexp.MustCompile(`\b(function|const|let|var|def|class|fn|struct|impl|interface|type)\s+\w`)
	reLineEnd  = regexp.MustCompile(`(?m)[{};]\s*$`)
	reIndent   = regexp.MustCompile(`(?m)^\s{2,}\S`)
	reArrow    = regexp.MustCompile(`=>|::|->|\)\s*\{|\breturn\b`)
	rePrompt   = regexp.MustCompile(`(?m)^\s*(\$|>)\s+\w`)
	reJSONLike = regexp.MustCompile(`^[\[{][\s\S]*[\]}]$`)
	reJSONKey  = regexp.MustCompile(`["']\s*:`)
	reTag      = regexp.MustCompile(`</?[a-zA-Z][\w-]*[^>]*>`)
	reCJK      = regexp.MustCompile(`[\x{4e00}-\x{9fff}]`)
)

// Detect 同 Tauri detectCode：命中足够结构特征才算代码；返回语言名，认不出具体语言为 "plaintext"，不是代码返回 ""。
func Detect(text string) string {
	t := strings.TrimSpace(text)
	n := utf8.RuneCountInString(t)
	if n < 12 {
		return ""
	}
	if float64(len(reCJK.FindAllStringIndex(t, -1)))/float64(n) > 0.25 {
		return ""
	}
	score := 0
	add := func(re *regexp.Regexp, v int) {
		if re.MatchString(t) {
			score += v
		}
	}
	add(reImport, 2)
	add(reDecl, 2)
	add(reLineEnd, 1)
	add(reIndent, 1)
	add(reArrow, 1)
	add(rePrompt, 1)
	if reJSONLike.MatchString(t) && reJSONKey.MatchString(t) {
		score += 2
	}
	add(reTag, 1)
	if score < 3 {
		return ""
	}
	return guess(t)
}

var guesses = []struct {
	lang string
	re   *regexp.Regexp
}{
	{"json", regexp.MustCompile(`^\s*[\[{]\s*("[^"]*"\s*:|\[|\{|"|\d)[\s\S]*[\]}]\s*$`)},
	{"xml", regexp.MustCompile(`^\s*<[!?a-zA-Z][\s\S]*>\s*$`)},
	{"sql", regexp.MustCompile(`(?i)^\s*(select|insert|update|delete|create|alter|drop|with)\s`)},
	{"bash", regexp.MustCompile(`(?m)^#!/(usr/)?bin/(env )?(ba|z)?sh|^\s*\$\s+\w|^\s*(sudo|npm|pnpm|yarn|git|cd|export|echo|brew|curl|docker|go|cargo)\s`)},
	{"go", regexp.MustCompile(`(?m)^package \w+|\bfunc (\(\w+ \*?\w+\) )?\w+\(|:= |\bfmt\.`)},
	{"rust", regexp.MustCompile(`\bfn \w+|\blet mut\b|\bimpl\b|\bpub (fn|struct|enum)\b|\w+::\w+`)},
	{"python", regexp.MustCompile(`(?m)^\s*def \w+\(.*\):|^\s*(from \w+ )?import \w+$|^\s*class \w+(\(.*\))?:|\bself\.|\bprint\(`)},
	{"java", regexp.MustCompile(`\bpublic (static |final )?(class|void|interface)\b|\bSystem\.out\.|\bprivate \w+ \w+;`)},
	{"typescript", regexp.MustCompile(`\binterface \w+ \{|:\s*(string|number|boolean|void)\b|\btype \w+ =|<\w+>\(`)},
	{"javascript", regexp.MustCompile(`\b(const|let|var|function)\b|=>|\bconsole\.|\brequire\(`)},
	{"css", regexp.MustCompile(`[\w.#\-:\[\]="]+\s*\{[^{}]*[\w-]+\s*:[^{}]*;`)},
	{"yaml", regexp.MustCompile(`(?m)^\s*[\w-]+:\s+\S[^{};]*$`)},
}

func guess(t string) string {
	for _, g := range guesses {
		if g.re.MatchString(t) {
			return g.lang
		}
	}
	return "plaintext"
}

// Label 同 Tauri langLabel：卡片通栏的语言名。
func Label(lang string) string {
	switch lang {
	case "", "plaintext":
		return "代码"
	case "javascript":
		return "js"
	case "typescript":
		return "ts"
	}
	return lang
}

// Kind 是着色类别。
type Kind int

const (
	Plain Kind = iota
	Keyword
	String
	Number
	Comment
)

type Token struct {
	Text string
	Kind Kind
}

func words(s string) map[string]bool {
	m := map[string]bool{}
	for _, w := range strings.Fields(s) {
		m[w] = true
	}
	return m
}

var keywords = map[string]map[string]bool{
	"go":         words("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false"),
	"rust":       words("as async await break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while Some None Ok Err"),
	"python":     words("and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self"),
	"java":       words("abstract boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long new package private protected public return short static super switch this throw throws try void while null true false"),
	"javascript": words("async await break case catch class const continue default delete do else export extends false finally for from function if import in instanceof let new null of return super switch this throw true try typeof undefined var void while yield"),
	"typescript": words("abstract any as async await boolean break case catch class const continue declare default delete do else enum export extends false finally for from function if implements import in instanceof interface keyof let new null number of private protected public readonly return string super switch this throw true try type typeof undefined var void while"),
	"sql":        words("SELECT FROM WHERE AND OR NOT IN IS NULL AS JOIN LEFT RIGHT INNER OUTER ON GROUP BY ORDER HAVING LIMIT OFFSET INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE ALTER DROP INDEX DISTINCT UNION ALL CASE WHEN THEN ELSE END DESC ASC LIKE BETWEEN WITH COUNT SUM MAX MIN AVG PRIMARY KEY DEFAULT"),
	"bash":       words("if then else elif fi for while do done case esac in function return export local echo cd sudo exit source alias unset set"),
	"css":        words("important media import from to"),
	"json":       words("true false null"),
	"yaml":       words("true false null yes no"),
}

func commentStyles(lang string) (line []string, block [2]string) {
	switch lang {
	case "python", "bash", "yaml":
		return []string{"#"}, [2]string{}
	case "sql":
		return []string{"--"}, [2]string{"/*", "*/"}
	case "xml":
		return nil, [2]string{"<!--", "-->"}
	case "json":
		return nil, [2]string{}
	case "css":
		return nil, [2]string{"/*", "*/"}
	}
	return []string{"//"}, [2]string{"/*", "*/"}
}

func isWord(b byte) bool {
	return b == '_' || b == '$' || b >= '0' && b <= '9' || b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z'
}

// Highlight 把代码切成着色片段（拼回去等于原文）。
func Highlight(src, lang string) []Token {
	kw := keywords[lang]
	line, block := commentStyles(lang)
	upper := lang == "sql"
	var out []Token
	push := func(s string, k Kind) {
		if s == "" {
			return
		}
		if n := len(out); n > 0 && out[n-1].Kind == k {
			out[n-1].Text += s
			return
		}
		out = append(out, Token{s, k})
	}
	lineStart := true
	for i := 0; i < len(src); {
		rest := src[i:]
		if block[0] != "" && strings.HasPrefix(rest, block[0]) {
			j := strings.Index(rest[len(block[0]):], block[1])
			end := len(rest)
			if j >= 0 {
				end = len(block[0]) + j + len(block[1])
			}
			push(rest[:end], Comment)
			i += end
			continue
		}
		isLineComment := false
		for _, l := range line {
			if strings.HasPrefix(rest, l) && !(l == "#" && lang == "bash" && strings.HasPrefix(rest, "#!") && !lineStart) {
				isLineComment = true
			}
		}
		if isLineComment {
			end := strings.IndexByte(rest, '\n')
			if end < 0 {
				end = len(rest)
			}
			push(rest[:end], Comment)
			i += end
			continue
		}
		ch := src[i]
		switch {
		case ch == '"' || ch == '\'' || ch == '`' && (lang == "javascript" || lang == "typescript" || lang == "go"):
			j := i + 1
			for j < len(src) && src[j] != ch {
				if src[j] == '\\' {
					j++
				} else if src[j] == '\n' && ch != '`' {
					break
				}
				j++
			}
			j = min(j+1, len(src))
			k := String
			if (lang == "json" || lang == "yaml") && strings.HasPrefix(strings.TrimLeft(src[j:], " \t"), ":") {
				k = Keyword // JSON / YAML 键
			}
			push(src[i:j], k)
			i = j
		case lang == "xml" && ch == '<':
			j := i + 1
			if j < len(src) && (src[j] == '/' || src[j] == '?' || src[j] == '!') {
				j++
			}
			for j < len(src) && (isWord(src[j]) || src[j] == '-' || src[j] == ':' || src[j] == '.') {
				j++
			}
			push(src[i:j], Keyword)
			i = j
		case ch >= '0' && ch <= '9':
			j := i
			for j < len(src) && (isWord(src[j]) || src[j] == '.') {
				j++
			}
			push(src[i:j], Number)
			i = j
		case isWord(ch):
			j := i
			for j < len(src) && isWord(src[j]) {
				j++
			}
			w := src[i:j]
			k := Plain
			if kw[w] || upper && kw[strings.ToUpper(w)] {
				k = Keyword
			} else if lang == "yaml" && lineStart && strings.HasPrefix(strings.TrimLeft(src[j:], " \t"), ":") {
				k = Keyword
			} else if lang == "css" && strings.HasPrefix(strings.TrimLeft(src[j:], " \t"), ":") {
				k = Keyword // 属性名
			}
			push(w, k)
			i = j
		default:
			_, size := utf8.DecodeRuneInString(rest)
			push(rest[:size], Plain)
			i += size
		}
		lineStart = ch == '\n' || lineStart && (ch == ' ' || ch == '\t' || ch == '-')
	}
	return out
}
