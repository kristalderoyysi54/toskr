package secretcodec

import (
	"bytes"
	"strings"
	"testing"
)

// 移植 crypto.test.ts。

func TestCryptoRoundTrip(t *testing.T) {
	for _, text := range []string{
		"",
		"今天老板又画饼了",
		"长文本" + strings.Repeat("。测试很长很长的内容", 50) + "🎉🙈码点",
		"mixed 中英 123 !@# 测试",
	} {
		b, err := encryptToBytes(text, "共享暗号")
		if err != nil {
			t.Fatal(err)
		}
		if got, err := decryptFromBytes(b, "共享暗号"); err != nil || got != text {
			t.Fatalf("往返 %q → %q %v", text, got, err)
		}
	}
}

func TestCryptoEnvelopeLayout(t *testing.T) {
	b, _ := encryptToBytes("四个字啊", "k")
	if b[0] != 0x86 || b[1] != 0x17 || b[2] != version {
		t.Fatalf("头部 % x", b[:3])
	}
	if len(b) != headerLen+8+16 {
		t.Fatalf("长度 %d", len(b))
	}
	if minEnvelopeLen != 47 || headerLen != 31 {
		t.Fatal("常量漂移")
	}
}

func TestCryptoRandomized(t *testing.T) {
	a, _ := encryptToBytes("重复", "k")
	b, _ := encryptToBytes("重复", "k")
	if bytes.Equal(a, b) {
		t.Fatal("同明文两次密文相同")
	}
}

func TestCryptoWrongKeyAndTamper(t *testing.T) {
	b, _ := encryptToBytes("机密", "对的密钥")
	if _, err := decryptFromBytes(b, "错的密钥"); err == nil {
		t.Fatal("错钥解开了")
	}
	tampered := bytes.Clone(b)
	tampered[len(tampered)-1] ^= 0xff
	if _, err := decryptFromBytes(tampered, "对的密钥"); err == nil {
		t.Fatal("篡改 tag 仍解开")
	}
}

func TestCryptoHeaderErrors(t *testing.T) {
	b, _ := encryptToBytes("x", "k")
	if _, err := decryptFromBytes(b[:5], "k"); err != errTooShort {
		t.Fatal(err)
	}
	badMagic := bytes.Clone(b)
	badMagic[0] ^= 0xff
	if _, err := decryptFromBytes(badMagic, "k"); err != errBadMagic {
		t.Fatal(err)
	}
	badVersion := bytes.Clone(b)
	badVersion[2] = 9
	if _, err := decryptFromBytes(badVersion, "k"); err != errBadVersion {
		t.Fatal(err)
	}
}

func TestUTF16LE(t *testing.T) {
	s := "a中🎉"
	b := utf16leEncode(s)
	want := []byte{'a', 0, 0x2d, 0x4e, 0x3c, 0xd8, 0x89, 0xdf}
	if !bytes.Equal(b, want) || utf16Len(s) != 4 {
		t.Fatalf("% x", b)
	}
	if got := utf16leDecode(append(b, 0x41)); got != s {
		t.Fatalf("奇数尾字节未忽略: %q", got)
	}
}
