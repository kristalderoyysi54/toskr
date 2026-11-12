package secretcodec

import (
	"bytes"
	"strings"
	"testing"
)

// 移植 chineseCodec.test.ts。

func innerChar(b byte) string {
	s := encodeChinese([]byte{b})
	return strings.TrimSuffix(strings.TrimPrefix(s, cnOpen), "。"+cnClose)
}

func TestCodebookFrozen(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 256; i++ {
		ch := innerChar(byte(i))
		r := []rune(ch)
		if len(r) != 1 || r[0] < 0x4e00 || r[0] > 0x9fff {
			t.Fatalf("%d → %q", i, ch)
		}
		seen[ch] = true
	}
	if len(seen) != 256 || len(cnTable) != 256 {
		t.Fatal("码本非 256 唯一字")
	}
	for b, want := range map[byte]string{0: "的", 23: "说", 134: "话", 255: "入"} {
		if got := innerChar(b); got != want {
			t.Fatalf("锚点 %d = %q", b, got)
		}
	}
}

func TestChineseRoundTrip(t *testing.T) {
	all := make([]byte, 256)
	for i := range all {
		all[i] = byte(i)
	}
	if !bytes.Equal(decodeChinese(encodeChinese(all)), all) {
		t.Fatal("256 字节往返失败")
	}
	for _, n := range []int{1, 5, 31, 47, 128, 300} {
		b := make([]byte, n)
		for i := range b {
			b[i] = byte((i*37 + 11) % 256)
		}
		if !bytes.Equal(decodeChinese(encodeChinese(b)), b) {
			t.Fatalf("长度 %d 往返失败", n)
		}
	}
}

func TestChineseTolerant(t *testing.T) {
	b := []byte{1, 2, 3, 250, 251, 252, 100, 200}
	polluted := "你看这个 " + strings.ReplaceAll(encodeChinese(b), "、", " ") + "\n （转发）"
	if !bytes.Equal(decodeChinese(polluted), b) {
		t.Fatal("IM 重排版后解码失败")
	}
}

func TestLooksLikeSecret(t *testing.T) {
	if looksLikeSecret("今天天气不错我们去吃饭吧", 47) || looksLikeSecret("你好世界", 47) || looksLikeSecret("「的一是」", 47) {
		t.Fatal("误判")
	}
	if decodeChinese("你好世界") == nil {
		t.Fatal("含码本字应可解出字节")
	}
	if !strings.HasPrefix(encodeChinese([]byte{134, 23, 5, 6, 7}), "「话说") {
		t.Fatal("魔数未渲染为「话说」")
	}
}
