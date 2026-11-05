package secretcodec

import (
	"encoding/hex"
	"errors"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// 文本协议层：同一份信封字节渲染为 classic/code/log/quote，接收方按严格语法自动识别。
// 对应 appearanceCodec.ts；所有长度均按 UTF-16 code unit 计，与 JS .length 一致。

// maxAppearanceChars 编解码共同硬上限。
const maxAppearanceChars = 1_000_000

var (
	errTooLong       = errors.New("秘文内容过长")
	errUnknownFormat = errors.New("不支持的秘文格式")
)

func isEnvelopeCandidate(b []byte) bool {
	return len(b) >= minEnvelopeLen && b[0] == magic[0] && b[1] == magic[1]
}

// hexToBytes 只接受非空、偶数长度的小写 hex。
func hexToBytes(s string) []byte {
	if s == "" || len(s)%2 != 0 || strings.ToLower(s) != s {
		return nil
	}
	b, err := hex.DecodeString(s)
	if err != nil {
		return nil
	}
	return b
}

// ---- code ----

type codeLanguage int

const (
	langJavaScript codeLanguage = iota
	langPython
	langGo
	langRust
)

var codeLanguages = [...]codeLanguage{langJavaScript, langPython, langGo, langRust}

// codeLanguageFor 按 salt 首字节稳定选型，重显不跳语言。
func codeLanguageFor(b []byte) codeLanguage {
	var s byte
	if len(b) > 3 {
		s = b[3]
	}
	return codeLanguages[int(s)%len(codeLanguages)]
}

func renderCode(h string, lang codeLanguage) string {
	switch lang {
	case langJavaScript:
		return "const cacheSnapshot = \"" + h + "\";\nexport default cacheSnapshot;"
	case langPython:
		return "CACHE_SNAPSHOT = bytes.fromhex(\n    \"" + h + "\"\n)"
	case langGo:
		return "package cache\n\nimport \"encoding/hex\"\n\nvar cacheSnapshot, _ = hex.DecodeString(\"" + h + "\")"
	default:
		return "pub const CACHE_SNAPSHOT: &str =\n    \"" + h + "\";"
	}
}

func encodeCode(b []byte) string {
	return renderCode(hex.EncodeToString(b), codeLanguageFor(b))
}

var codePatterns = [...]struct {
	lang codeLanguage
	re   *regexp.Regexp
}{
	{langJavaScript, regexp.MustCompile(`^const cacheSnapshot = "([0-9a-f]+)";\nexport default cacheSnapshot;$`)},
	{langPython, regexp.MustCompile(`^CACHE_SNAPSHOT = bytes\.fromhex\(\n    "([0-9a-f]+)"\n\)$`)},
	{langGo, regexp.MustCompile(`^package cache\n\nimport "encoding/hex"\n\nvar cacheSnapshot, _ = hex\.DecodeString\("([0-9a-f]+)"\)$`)},
	{langRust, regexp.MustCompile(`^pub const CACHE_SNAPSHOT: &str =\n    "([0-9a-f]+)";$`)},
}

var (
	fenceRe        = regexp.MustCompile("^```(javascript|js|python|py|go|rust)\\n([\\s\\S]+)\\n```$")
	fenceLanguages = map[string]codeLanguage{
		"javascript": langJavaScript, "js": langJavaScript,
		"python": langPython, "py": langPython,
		"go": langGo, "rust": langRust,
	}
)

func decodeCode(text string) []byte {
	source := text
	fenced, hasFence := codeLanguage(0), false
	if m := fenceRe.FindStringSubmatch(text); m != nil {
		fenced, hasFence = fenceLanguages[m[1]], true
		source = m[2]
	} else if strings.HasPrefix(text, "```") {
		return nil
	}
	for _, p := range codePatterns {
		if hasFence && fenced != p.lang {
			continue
		}
		if m := p.re.FindStringSubmatch(source); m != nil {
			return hexToBytes(m[1])
		}
	}
	return nil
}

// ---- log ----

const (
	logChunkLen    = 64
	logSpanSeconds = 6 * 365 * 24 * 60 * 60
	logTimeLayout  = "2006-01-02T15:04:05.000Z"
)

var (
	logLineRe = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) INFO cache\.restore trace=([0-9a-f]{8}) chunk=(\d+)/(\d+) payload=([0-9a-f]{2,64})$`)
	logEpoch  = time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
)

func logTimestampFor(b []byte) string {
	var seed int64
	for i := 7; i < 11; i++ {
		var c byte
		if i < len(b) {
			c = b[i]
		}
		seed = seed*256 + int64(c)
	}
	return logEpoch.Add(time.Duration(seed%logSpanSeconds) * time.Second).Format(logTimeLayout)
}

func logTraceFor(b []byte) string {
	lo, hi := min(3, len(b)), min(7, len(b))
	t := hex.EncodeToString(b[lo:hi])
	return t + strings.Repeat("0", 8-len(t))
}

func encodeLog(b []byte) string {
	h := hex.EncodeToString(b)
	ts, trace := logTimestampFor(b), logTraceFor(b)
	total := (len(h) + logChunkLen - 1) / logChunkLen
	lines := make([]string, 0, total)
	for i := 0; i < total; i++ {
		chunk := h[i*logChunkLen : min(len(h), (i+1)*logChunkLen)]
		lines = append(lines, ts+" INFO cache.restore trace="+trace+" chunk="+
			strconv.Itoa(i+1)+"/"+strconv.Itoa(total)+" payload="+chunk)
	}
	return strings.Join(lines, "\n")
}

// sameNumber 等价 JS Number(digits) === n（digits 已限定为 \d+，允许前导零）。
func sameNumber(digits string, n int) bool {
	return strings.TrimLeft(digits, "0") == strconv.Itoa(n)
}

// isCanonicalISO 等价 Date.parse 合法且 toISOString 往返一致。
func isCanonicalISO(s string) bool {
	t, err := time.Parse(logTimeLayout, s)
	return err == nil && t.UTC().Format(logTimeLayout) == s
}

func decodeLog(text string) []byte {
	lines := strings.Split(text, "\n")
	var ts, trace string
	var payload strings.Builder
	for i, line := range lines {
		m := logLineRe.FindStringSubmatch(line)
		if m == nil {
			return nil
		}
		lineTS, lineTrace, idx, total, chunk := m[1], m[2], m[3], m[4], m[5]
		if !isCanonicalISO(lineTS) ||
			!sameNumber(idx, i+1) ||
			!sameNumber(total, len(lines)) ||
			(i < len(lines)-1 && len(chunk) != logChunkLen) ||
			len(chunk)%2 != 0 {
			return nil
		}
		if i == 0 {
			ts, trace = lineTS, lineTrace
		} else if lineTS != ts || lineTrace != trace {
			return nil
		}
		payload.WriteString(chunk)
	}
	b := hexToBytes(payload.String())
	if b == nil || logTraceFor(b) != trace {
		return nil
	}
	return b
}

// ---- quote ----

// quoteWords 冻结 64-word 码本：索引即 6-bit token。⚠️ 不可重排。
var quoteWords = [64]string{
	"after", "again", "air", "along", "among", "and", "away", "back",
	"before", "below", "beyond", "blue", "bright", "but", "calm", "clear",
	"close", "dark", "day", "deep", "down", "each", "east", "even",
	"far", "field", "first", "for", "from", "green", "here", "high",
	"home", "into", "last", "light", "long", "low", "near", "night",
	"north", "now", "old", "once", "only", "over", "past", "quiet",
	"river", "road", "sea", "sky", "soft", "still", "stone", "sun",
	"there", "through", "time", "tree", "under", "water", "west", "wind",
}

const (
	quoteWordsPerLine = 12
	quoteSignature    = "> — Field Notes"
)

var (
	quoteWordIndex = func() map[string]int {
		m := make(map[string]int, len(quoteWords))
		for i, w := range quoteWords {
			m[w] = i
		}
		return m
	}()
	quoteAvgWordLen, quoteMaxWordLen = func() (float64, int) {
		sum, mx := 0, 0
		for _, w := range quoteWords {
			sum += len(w)
			mx = max(mx, len(w))
		}
		return float64(sum) / float64(len(quoteWords)), mx
	}()
)

func bytesToSixBit(b []byte) []int {
	tokens := make([]int, 0, (len(b)*8+5)/6)
	buf, bits := 0, 0
	for _, c := range b {
		buf = buf<<8 | int(c)
		bits += 8
		for bits >= 6 {
			bits -= 6
			tokens = append(tokens, (buf>>bits)&0x3f)
			buf &= 1<<bits - 1
		}
	}
	if bits > 0 {
		tokens = append(tokens, (buf<<(6-bits))&0x3f)
	}
	return tokens
}

// sixBitToBytes 补零位非零视为非规范文本。
func sixBitToBytes(tokens []int) []byte {
	if len(tokens) == 0 || len(tokens)%4 == 1 {
		return nil
	}
	out := make([]byte, 0, len(tokens)*6/8)
	buf, bits := 0, 0
	for _, t := range tokens {
		if t < 0 || t > 0x3f {
			return nil
		}
		buf = buf<<6 | t
		bits += 6
		for bits >= 8 {
			bits -= 8
			out = append(out, byte(buf>>bits))
			buf &= 1<<bits - 1
		}
	}
	if buf != 0 {
		return nil
	}
	return out
}

func encodeQuote(b []byte) string {
	tokens := bytesToSixBit(b)
	words := make([]string, len(tokens))
	for i, t := range tokens {
		words[i] = quoteWords[t]
	}
	var lines []string
	for i := 0; i < len(words); i += quoteWordsPerLine {
		chunk := strings.Join(words[i:min(len(words), i+quoteWordsPerLine)], " ")
		first := ""
		if i == 0 {
			first = `"`
		}
		end := ","
		if i+quoteWordsPerLine >= len(words) {
			end = `."`
		}
		lines = append(lines, "> "+first+chunk+end)
	}
	return strings.Join(append(lines, ">", quoteSignature), "\n")
}

func decodeQuote(text string) []byte {
	lines := strings.Split(text, "\n")
	if len(lines) < 3 || lines[len(lines)-2] != ">" || lines[len(lines)-1] != quoteSignature {
		return nil
	}
	body := lines[:len(lines)-2]
	var words []string
	closing := `"`
	for i, line := range body {
		var ok bool
		if line, ok = strings.CutPrefix(line, "> "); !ok {
			return nil
		}
		if i == 0 {
			// 接受 IM 规范化后的成对智能引号
			if rest, ok := strings.CutPrefix(line, `"`); ok {
				closing, line = `"`, rest
			} else if rest, ok := strings.CutPrefix(line, "“"); ok {
				closing, line = "”", rest
			} else {
				return nil
			}
		}
		last := i == len(body)-1
		if last {
			if line, ok = strings.CutSuffix(line, "."+closing); !ok {
				return nil
			}
		} else if line, ok = strings.CutSuffix(line, ","); !ok {
			return nil
		}
		lw := strings.Split(line, " ")
		if len(lw) > quoteWordsPerLine || (!last && len(lw) != quoteWordsPerLine) {
			return nil
		}
		words = append(words, lw...)
	}
	tokens := make([]int, len(words))
	for i, w := range words {
		t, ok := quoteWordIndex[w]
		if !ok {
			return nil
		}
		tokens[i] = t
	}
	return sixBitToBytes(tokens)
}

// ---- 长度 ----

func decimalDigits(n int) int { return len(strconv.Itoa(n)) }

// codeOverhead 四种语言模板（空 hex）长度上界。
var codeOverhead = func() int {
	mx := 0
	for _, l := range codeLanguages {
		mx = max(mx, len(renderCode("", l)))
	}
	return mx
}()

// estimateAppearanceLength = estimateSecretAppearanceLength；未知格式返回错误。
func estimateAppearanceLength(n int, style Style) (int, error) {
	n = max(0, n)
	switch style {
	case StyleClassic:
		// Math.round(n/6)，n ≥ 0
		return n + (n+3)/6 + 3, nil
	case StyleCode:
		return n*2 + codeOverhead, nil
	case StyleLog:
		hexLen := n * 2
		chunks := max(1, (hexLen+logChunkLen-1)/logChunkLen)
		totalDigits := decimalDigits(chunks)
		length := hexLen + max(0, chunks-1)
		for i := 1; i <= chunks; i++ {
			length += 24 + len(" INFO cache.restore trace=") + 8 + len(" chunk=") +
				decimalDigits(i) + 1 + totalDigits + len(" payload=")
		}
		return length, nil
	case StyleQuote:
		tokens := (n*8 + 5) / 6
		lines := max(1, (tokens+quoteWordsPerLine-1)/quoteWordsPerLine)
		// tokens*平均词长是 1/64 的整数倍，floor(x+0.5) 与 Math.round 一致
		return int(math.Floor(float64(tokens)*quoteAvgWordLen+0.5)) + tokens + lines*3 + 19, nil
	}
	return 0, errUnknownFormat
}

// appearanceLengthSupported = isSecretAppearanceLengthSupported（按最坏模板）。
func appearanceLengthSupported(n int, style Style) (bool, error) {
	n = max(0, n)
	switch style {
	case StyleClassic:
		maxMarks := (max(0, n-1) + 3) / 4
		return n+maxMarks+3 <= maxAppearanceChars, nil
	case StyleCode, StyleLog:
		l, _ := estimateAppearanceLength(n, style)
		return l <= maxAppearanceChars, nil
	case StyleQuote:
		tokens := (n*8 + 5) / 6
		lines := max(1, (tokens+quoteWordsPerLine-1)/quoteWordsPerLine)
		maxLen := tokens*quoteMaxWordLen + max(0, tokens-lines) + lines*4 + 32
		return maxLen <= maxAppearanceChars, nil
	}
	return false, errUnknownFormat
}

// ---- 编解码入口 ----

// encodeAppearance 同一信封字节 → 指定文本协议。
func encodeAppearance(b []byte, style Style) (string, error) {
	var s string
	switch style {
	case StyleClassic:
		s = encodeChinese(b)
	case StyleCode:
		s = encodeCode(b)
	case StyleLog:
		s = encodeLog(b)
	case StyleQuote:
		s = encodeQuote(b)
	default:
		return "", errUnknownFormat
	}
	if utf16Len(s) > maxAppearanceChars {
		return "", errTooLong
	}
	return s, nil
}

// 上一版“外壳包中文”的历史格式。
var legacyWrappers = [...]struct {
	style Style
	re    *regexp.Regexp
}{
	{StyleCode, regexp.MustCompile(`^const cacheSnapshot = "「[\s\S]*」";$`)},
	{StyleLog, regexp.MustCompile(`^\[debug\] cache\.snapshot=「[\s\S]*」$`)},
	{StyleQuote, regexp.MustCompile(`^> 「[\s\S]*」$`)},
}

func decodeLegacyWrapped(text string) (Style, []byte) {
	for _, w := range legacyWrappers {
		if !w.re.MatchString(text) {
			continue
		}
		if !looksLikeSecret(text, minEnvelopeLen) {
			return "", nil
		}
		if b := decodeChinese(text); isEnvelopeCandidate(b) {
			return w.style, b
		}
		return "", nil
	}
	return "", nil
}

// isJSWhitespace 等价 String.prototype.trim 剥除的 WhiteSpace + LineTerminator。
func isJSWhitespace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

// decodeAppearance 自动识别四种协议及历史包壳格式；不匹配返回 nil（fail-closed）。
func decodeAppearance(text string) (Style, []byte) {
	if utf16Len(text) > maxAppearanceChars {
		return "", nil
	}
	normalized := strings.ReplaceAll(strings.TrimFunc(text, isJSWhitespace), "\r\n", "\n")
	for _, d := range [...]struct {
		style  Style
		decode func(string) []byte
	}{{StyleCode, decodeCode}, {StyleLog, decodeLog}, {StyleQuote, decodeQuote}} {
		if b := d.decode(normalized); isEnvelopeCandidate(b) {
			return d.style, b
		}
	}
	if s, b := decodeLegacyWrapped(normalized); b != nil {
		return s, b
	}
	if !looksLikeSecret(normalized, minEnvelopeLen) {
		return "", nil
	}
	if b := decodeChinese(normalized); isEnvelopeCandidate(b) {
		return StyleClassic, b
	}
	return "", nil
}
