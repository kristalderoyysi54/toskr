package secretcodec

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// testdata/ts_vectors.json 由 TS 版（src/lib/secret）生成，锚定跨语言线兼容。

type sealVector struct {
	Style       Style  `json:"style"`
	Passphrase  string `json:"passphrase"`
	Plaintext   string `json:"plaintext"`
	Cipher      string `json:"cipher"`
	Fingerprint string `json:"fingerprint,omitempty"`
}

type tsVectors struct {
	Seal  []sealVector `json:"seal"`
	Fixed []struct {
		Plaintext, Passphrase, Salt, IV, Envelope string
	} `json:"fixed"`
	Appearance []struct {
		Style Style  `json:"style"`
		Bytes string `json:"bytes"`
		Text  string `json:"text"`
	} `json:"appearance"`
	Lengths []struct {
		Style        Style   `json:"style"`
		PlaintextLen int     `json:"plaintextLen"`
		Plaintext    *string `json:"plaintext"`
		Estimate     int     `json:"estimate"`
		Supported    bool    `json:"supported"`
	} `json:"lengths"`
}

func loadVectors(t *testing.T, path string) tsVectors {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var v tsVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func checkOpenVectors(t *testing.T, vs []sealVector) {
	for i, v := range vs {
		t.Run(string(v.Style), func(t *testing.T) {
			t.Parallel()
			if style, b := decodeAppearance(v.Cipher); b == nil || style != v.Style {
				t.Fatalf("#%d 识别为 %q", i, style)
			}
			r := Open(v.Cipher, []Key{{ID: "wrong", Passphrase: v.Passphrase + "!"}, {ID: "k", Label: "l", Passphrase: v.Passphrase}})
			if r != (OpenResult{Status: "plaintext", Plaintext: v.Plaintext, KeyID: "k", KeyLabel: "l"}) {
				t.Fatalf("#%d %s: got %+v", i, v.Style, r)
			}
		})
	}
}

func TestTSVectorsOpen(t *testing.T) {
	v := loadVectors(t, "testdata/ts_vectors.json")
	if len(v.Seal) == 0 {
		t.Fatal("无向量")
	}
	checkOpenVectors(t, v.Seal)
}

// 可选：SECRETCODEC_EXTRA_VECTORS 指向 TS 生成的近上限大向量（体积大，不入库）。
func TestTSExtraVectorsOpen(t *testing.T) {
	path := os.Getenv("SECRETCODEC_EXTRA_VECTORS")
	if path == "" {
		t.Skip("未设置 SECRETCODEC_EXTRA_VECTORS")
	}
	checkOpenVectors(t, loadVectors(t, path).Seal)
}

func TestTSVectorsFixedEnvelope(t *testing.T) {
	for _, f := range loadVectors(t, "testdata/ts_vectors.json").Fixed {
		env, err := encryptWith(f.Plaintext, f.Passphrase, mustHex(t, f.Salt), mustHex(t, f.IV))
		if err != nil {
			t.Fatal(err)
		}
		if got := hex.EncodeToString(env); got != f.Envelope {
			t.Fatalf("%q 信封不一致\n go=%s\n ts=%s", f.Plaintext, got, f.Envelope)
		}
		if p, err := decryptFromBytes(env, f.Passphrase); err != nil || p != f.Plaintext {
			t.Fatalf("%q 解密 %q %v", f.Plaintext, p, err)
		}
	}
}

func TestTSVectorsAppearance(t *testing.T) {
	for _, a := range loadVectors(t, "testdata/ts_vectors.json").Appearance {
		b := mustHex(t, a.Bytes)
		got, err := encodeAppearance(b, a.Style)
		if err != nil || got != a.Text {
			t.Fatalf("%s %dB 渲染不一致 err=%v\n go=%q\n ts=%q", a.Style, len(b), err, got, a.Text)
		}
		style, back := decodeAppearance(a.Text)
		if style != a.Style || hex.EncodeToString(back) != a.Bytes {
			t.Fatalf("%s %dB 识别 %q", a.Style, len(b), style)
		}
	}
}

func TestTSVectorsLengths(t *testing.T) {
	for _, l := range loadVectors(t, "testdata/ts_vectors.json").Lengths {
		p := strings.Repeat("x", l.PlaintextLen)
		if l.Plaintext != nil {
			p = *l.Plaintext
		}
		if got := EstimateLength(p, l.Style); got != l.Estimate {
			t.Errorf("%s len=%d 估算 go=%d ts=%d", l.Style, l.PlaintextLen, got, l.Estimate)
		}
		if got := LengthSupported(p, l.Style); got != l.Supported {
			t.Errorf("%s len=%d 上限 go=%v ts=%v", l.Style, l.PlaintextLen, got, l.Supported)
		}
	}
}

// SECRETCODEC_WRITE_GO_VECTORS=<path> 时输出 Go 封装的向量，供 TS openSecret 反向验证。
func TestWriteGoVectors(t *testing.T) {
	path := os.Getenv("SECRETCODEC_WRITE_GO_VECTORS")
	if path == "" {
		t.Skip("未设置 SECRETCODEC_WRITE_GO_VECTORS")
	}
	plaintexts := []string{
		"", "hello, world", "今天老板又画饼了", "🎉🙈 emoji 代理对 👨‍👩‍👧",
		"mixed 中英 123 !@#\n第二行\t制表", "  leading/trailing whitespace  \r\n",
		"长文本" + strings.Repeat("。测试很长很长的内容", 200) + "🎉",
	}
	passphrases := []string{"共享暗号", "k", "pass with spaces 🔑", ""}
	var out []sealVector
	add := func(p, pass string, s Style) string {
		c, err := Seal(p, pass, s)
		if err != nil {
			t.Fatalf("%s %d: %v", s, utf16Len(p), err)
		}
		fp, _ := Fingerprint(c)
		out = append(out, sealVector{s, pass, p, c, fp})
		return c
	}
	for _, o := range StyleOptions {
		for i, p := range plaintexts {
			add(p, passphrases[i%len(passphrases)], o.Value)
		}
		// 近上限：恰好最大可支持长度
		n := maxSupportedLen(o.Value)
		big := []rune(strings.Repeat("秘文ab", n/4+1))[:n]
		add(string(big), "共享暗号", o.Value)
		if _, err := Seal(string(big)+"x", "k", o.Value); err != errTooLong {
			t.Fatalf("%s 超上限未拒绝: %v", o.Value, err)
		}
	}
	// code 补齐四种语言
	seen := map[codeLanguage]bool{}
	for len(seen) < 4 {
		c := add("语言覆盖", "共享暗号", StyleCode)
		_, b := decodeAppearance(c)
		seen[codeLanguageFor(b)] = true
	}
	raw, _ := json.Marshal(map[string]any{"seal": out})
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Logf("写出 %d 条 → %s", len(out), path)
}

func maxSupportedLen(s Style) int {
	lo, hi := 0, 1_000_000
	for lo < hi {
		mid := (lo + hi + 1) / 2
		if LengthSupported(strings.Repeat("x", mid), s) {
			lo = mid
		} else {
			hi = mid - 1
		}
	}
	return lo
}
