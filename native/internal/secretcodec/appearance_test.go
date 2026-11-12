package secretcodec

import (
	"bytes"
	"regexp"
	"strings"
	"testing"
)

// 移植 appearanceCodec.test.ts。

func fixtureEnvelope() []byte {
	b := []byte{0x86, 0x17, 0x01}
	for i := 0; i < 16; i++ {
		b = append(b, byte(i))
	}
	for i := 0; i < 12; i++ {
		b = append(b, byte(0xa0+i))
	}
	for i := 0; i < 16; i++ {
		b = append(b, byte(0xf0-i))
	}
	return b
}

func mustEncode(t *testing.T, b []byte, s Style) string {
	t.Helper()
	out, err := encodeAppearance(b, s)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func decodedBytes(text string) []byte {
	_, b := decodeAppearance(text)
	return b
}

var cjkRe = regexp.MustCompile(`[「」\x{3400}-\x{9fff}]`)

func TestFrozenFixedVectors(t *testing.T) {
	env := fixtureEnvelope()
	cases := map[Style]string{
		StyleCode: "const cacheSnapshot = \"861701000102030405060708090a0b0c0d0e0fa0a1a2a3a4a5a6a7a8a9aaabf0efeeedecebeae9e8e7e6e5e4e3e2e1\";\n" +
			"export default cacheSnapshot;",
		StyleLog: "2026-02-19T12:48:07.000Z INFO cache.restore trace=00010203 chunk=1/2 payload=861701000102030405060708090a0b0c0d0e0fa0a1a2a3a4a5a6a7a8a9aaabf0\n" +
			"2026-02-19T12:48:07.000Z INFO cache.restore trace=00010203 chunk=2/2 payload=efeeedecebeae9e8e7e6e5e4e3e2e1",
		StyleQuote: "> \"into into from again after after among air after river close and,\n" +
			"> again home from before air close north blue along after soft calm,\n" +
			"> along time air into north old calm long now first first night,\n" +
			"> old beyond near old old wind along quiet tree past sun only,\n" +
			"> time west once now time calm high near through here deep light,\n" +
			"> there past among.\"\n>\n> — Field Notes",
	}
	for s, want := range cases {
		if got := mustEncode(t, env, s); got != want {
			t.Fatalf("%s 漂移:\n%s", s, got)
		}
	}
}

func TestQuoteCodebookOrder(t *testing.T) {
	var b []byte
	for i := 0; i < 64; i += 4 {
		a, c, d, e := i, i+1, i+2, i+3
		b = append(b, byte(a<<2|c>>4), byte((c&0x0f)<<4|d>>2), byte((d&0x03)<<6|e))
	}
	want := "> \"after again air along among and away back before below beyond blue,\n" +
		"> bright but calm clear close dark day deep down each east even,\n" +
		"> far field first for from green here high home into last light,\n" +
		"> long low near night north now old once only over past quiet,\n" +
		"> river road sea sky soft still stone sun there through time tree,\n" +
		"> under water west wind.\"\n>\n> — Field Notes"
	if got := mustEncode(t, b, StyleQuote); got != want {
		t.Fatalf("码本顺序漂移:\n%s", got)
	}
}

func TestStyleOptions(t *testing.T) {
	want := []StyleOption{
		{"classic", "中文文本", "中文"},
		{"code", "代码（随机语言）", "代码"},
		{"log", "日志记录", "日志"},
		{"quote", "英文引用", "引用"},
	}
	if len(StyleOptions) != len(want) {
		t.Fatal(len(StyleOptions))
	}
	for i := range want {
		if StyleOptions[i] != want[i] {
			t.Fatalf("%+v", StyleOptions[i])
		}
	}
	for _, o := range StyleOptions {
		if NormalizeStyle(string(o.Value)) != o.Value {
			t.Fatal(o.Value)
		}
	}
	if NormalizeStyle("memo") != StyleClassic || NormalizeStyle("") != StyleClassic {
		t.Fatal("未知值应回落 classic")
	}
}

func TestAppearanceRoundTrip(t *testing.T) {
	env := fixtureEnvelope()
	for _, o := range StyleOptions {
		style, b := decodeAppearance(mustEncode(t, env, o.Value))
		if style != o.Value || !bytes.Equal(b, env) {
			t.Fatalf("%s 往返失败: %q", o.Value, style)
		}
	}
}

func TestCodeFourLanguages(t *testing.T) {
	patterns := []*regexp.Regexp{
		regexp.MustCompile(`^const cacheSnapshot = "[0-9a-f]+";\nexport default cacheSnapshot;$`),
		regexp.MustCompile(`^CACHE_SNAPSHOT = bytes\.fromhex\(\n    "[0-9a-f]+"\n\)$`),
		regexp.MustCompile(`^package cache\n\nimport "encoding/hex"\n\nvar cacheSnapshot, _ = hex\.DecodeString\("[0-9a-f]+"\)$`),
		regexp.MustCompile(`^pub const CACHE_SNAPSHOT: &str =\n    "[0-9a-f]+";$`),
	}
	for salt, re := range patterns {
		v := fixtureEnvelope()
		v[3] = byte(salt)
		r := mustEncode(t, v, StyleCode)
		if !re.MatchString(r) || cjkRe.MatchString(r) || !bytes.Equal(decodedBytes(r), v) || mustEncode(t, v, StyleCode) != r {
			t.Fatalf("salt=%d:\n%s", salt, r)
		}
	}
}

func TestNoChineseInNewStyles(t *testing.T) {
	env := fixtureEnvelope()
	for _, s := range []Style{StyleCode, StyleLog, StyleQuote} {
		r := mustEncode(t, env, s)
		if cjkRe.MatchString(r) || decodeChinese(r) != nil {
			t.Fatalf("%s 夹带中文", s)
		}
	}
}

func TestLogStructure(t *testing.T) {
	r := mustEncode(t, fixtureEnvelope(), StyleLog)
	lines := strings.Split(r, "\n")
	if len(lines) < 2 || !strings.Contains(r, "trace=00010203") {
		t.Fatal(r)
	}
	for _, l := range lines {
		if !logLineRe.MatchString(l) {
			t.Fatal(l)
		}
	}
}

func TestQuoteSmartQuotes(t *testing.T) {
	env := fixtureEnvelope()
	r := mustEncode(t, env, StyleQuote)
	smart := strings.Replace(strings.Replace(r, `> "`, "> “", 1), `."`+"\n>\n> — Field Notes", ".”\n>\n> — Field Notes", 1)
	if !bytes.Equal(decodedBytes(smart), env) {
		t.Fatal("智能引号未识别")
	}
	if decodedBytes(strings.Replace(smart, ".”", `."`, 1)) != nil {
		t.Fatal("引号不成对应拒绝")
	}
}

func TestQuotePaddingAndRemainders(t *testing.T) {
	env := fixtureEnvelope()
	for extra := 0; extra < 3; extra++ {
		v := append(bytes.Clone(env), make([]byte, extra)...)
		if !bytes.Equal(decodedBytes(mustEncode(t, v, StyleQuote)), v) {
			t.Fatalf("余数 %d 往返失败", extra)
		}
	}
	bad := strings.Replace(mustEncode(t, env, StyleQuote), `among."`, `and."`, 1)
	if decodedBytes(bad) != nil {
		t.Fatal("非零补位应拒绝")
	}
	r := mustEncode(t, env, StyleQuote)
	if regexp.MustCompile(`[0-9a-f]{16}`).MatchString(r) || regexp.MustCompile(`[A-Za-z0-9+/=_-]{32}`).MatchString(r) {
		t.Fatal("引用暴露长串")
	}
}

func TestLegacyWrappedClassic(t *testing.T) {
	env := fixtureEnvelope()
	classic := encodeChinese(env)
	for _, f := range []struct {
		style Style
		text  string
	}{
		{StyleClassic, classic},
		{StyleCode, `const cacheSnapshot = "` + strings.ReplaceAll(classic, "\n", `\n`) + `";`},
		{StyleLog, "[debug] cache.snapshot=" + strings.ReplaceAll(classic, "\n", " ")},
		{StyleQuote, "> " + strings.ReplaceAll(classic, "\n", "\n> ")},
	} {
		style, b := decodeAppearance(f.text)
		if style != f.style || !bytes.Equal(b, env) {
			t.Fatalf("%s 历史格式识别为 %q", f.style, style)
		}
	}
}

func TestTransportNormalization(t *testing.T) {
	env := fixtureEnvelope()
	for _, o := range StyleOptions {
		r := mustEncode(t, env, o.Value)
		transported := " \n" + strings.ReplaceAll(r, "\n", "\r\n") + "\n "
		if !bytes.Equal(decodedBytes(transported), env) {
			t.Fatalf("%s CRLF/空白后识别失败", o.Value)
		}
		// JS trim 额外剥除的 U+FEFF / U+3000
		if !bytes.Equal(decodedBytes("\ufeff\u3000"+r+"\u2028"), env) {
			t.Fatalf("%s JS 空白集合不一致", o.Value)
		}
	}
	code := mustEncode(t, env, StyleCode)
	if !bytes.Equal(decodedBytes("```js\n"+code+"\n```"), env) {
		t.Fatal("匹配语言的 fence 应识别")
	}
	if decodedBytes("```python\n"+code+"\n```") != nil {
		t.Fatal("语言不匹配的 fence 应拒绝")
	}
	// U+0085 不在 JS trim 集合内（Go TrimSpace 会剥）
	if decodedBytes("\u0085"+code) != nil {
		t.Fatal("U+0085 不应被 trim")
	}
}

func TestFailClosed(t *testing.T) {
	env := fixtureEnvelope()
	validCode := mustEncode(t, env, StyleCode)
	validLog := mustEncode(t, env, StyleLog)
	validQuote := mustEncode(t, env, StyleQuote)
	wrong := bytes.Clone(env)
	wrong[0] = 0
	for i, text := range []string{
		`const cacheSnapshot = "hello";`,
		"const cacheSnapshot = \"8617\";\nexport default cacheSnapshot;",
		validCode[:len(validCode)-1],
		validCode + "\n// trailing text",
		strings.Replace(validLog, "chunk=1/2", "chunk=2/2", 1),
		strings.Replace(validLog, "INFO", "WARN", 1),
		validLog[:len(validLog)-1],
		strings.Replace(validQuote, "Field Notes", "Release Notes", 1),
		regexp.MustCompile(`^> "[a-z]+`).ReplaceAllString(validQuote, `> "unknown`),
		validQuote[:len(validQuote)-1],
		mustEncode(t, wrong, StyleCode),
		mustEncode(t, wrong, StyleLog),
		mustEncode(t, wrong, StyleQuote),
		"> \"ordinary English quote.\"\n>\n> — Field Notes",
		"普通备忘：明天开会",
		strings.Repeat("x", 1_000_001),
		"",
		// 非规范时间戳（2 月 30 日）往返不一致
		strings.ReplaceAll(validLog, "2026-02-19", "2026-02-30"),
	} {
		if _, b := decodeAppearance(text); b != nil {
			t.Fatalf("#%d 应 fail-closed", i)
		}
	}
}

func TestLogChunkLeadingZero(t *testing.T) {
	// JS Number("01") === 1：前导零的块序号仍被接受
	env := fixtureEnvelope()
	r := strings.ReplaceAll(mustEncode(t, env, StyleLog), "chunk=1/2", "chunk=01/2")
	if !bytes.Equal(decodedBytes(r), env) {
		t.Fatal("前导零块序号应与 TS 一样接受")
	}
}

func TestEstimateAccuracy(t *testing.T) {
	env := fixtureEnvelope()
	for _, o := range StyleOptions {
		actual := utf16Len(mustEncode(t, env, o.Value))
		est, err := estimateAppearanceLength(len(env), o.Value)
		if err != nil {
			t.Fatal(err)
		}
		if o.Value == StyleCode {
			if est < actual || est-actual >= 64 {
				t.Fatalf("code 估算 %d vs %d", est, actual)
			}
		} else if d := float64(est-actual) / float64(actual); d >= 0.12 || d <= -0.12 {
			t.Fatalf("%s 估算 %d vs %d", o.Value, est, actual)
		}
	}
}

func TestHardLimit(t *testing.T) {
	env := fixtureEnvelope()
	for _, o := range StyleOptions {
		if ok, _ := appearanceLengthSupported(len(env), o.Value); !ok {
			t.Fatal(o.Value)
		}
		if ok, _ := appearanceLengthSupported(1_000_000, o.Value); ok {
			t.Fatal(o.Value)
		}
	}
	if _, err := encodeAppearance(make([]byte, 600_000), StyleCode); err != errTooLong {
		t.Fatal(err)
	}
}

func TestUnknownStyleRejected(t *testing.T) {
	if _, err := encodeAppearance(fixtureEnvelope(), "unknown"); err != errUnknownFormat {
		t.Fatal(err)
	}
	if _, err := estimateAppearanceLength(100, "unknown"); err != errUnknownFormat {
		t.Fatal(err)
	}
	if _, err := appearanceLengthSupported(100, "unknown"); err != errUnknownFormat {
		t.Fatal(err)
	}
	if EstimateLength("x", "unknown") != -1 || LengthSupported("x", "unknown") {
		t.Fatal("公开 API 未知格式")
	}
	if _, err := Seal("x", "k", "unknown"); err != errUnknownFormat {
		t.Fatal(err)
	}
}
