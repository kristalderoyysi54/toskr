package secretcodec

import (
	"regexp"
	"strings"
	"testing"
	"unicode/utf8"
)

// 移植 secret.test.ts。

func TestLegacyClassicFixedVector(t *testing.T) {
	// 独立 Web Crypto 固定向量：salt=00..0f、iv=a0..ab
	legacy := "「话说一的，一是了我不人，在他有这个上，们来到将月十\n" +
		"实向声车全信，重三机都点把白加；高母向乐年自、对其会结没\n" +
		"分西信就高关、当在全少重，但。」"
	if !IsEnvelope(legacy) {
		t.Fatal("未识别")
	}
	if fp, ok := Fingerprint(legacy); !ok || fp != "861701000102030405060708090a0b0c0d0e0fa0a1a2a3a4a5a6a7a8a9aaab3a9245ddc380efa4e61a26318328e5406d9da81c80f83f07a7cea958" {
		t.Fatal(fp)
	}
	got := Open(legacy, []Key{{ID: "legacy", Label: "旧钥", Passphrase: "固定旧钥"}})
	if got != (OpenResult{Status: "plaintext", Plaintext: "旧版秘文可解", KeyID: "legacy", KeyLabel: "旧钥"}) {
		t.Fatalf("%+v", got)
	}
}

func TestSealOpenEveryStyle(t *testing.T) {
	for _, o := range StyleOptions {
		t.Run(string(o.Value), func(t *testing.T) {
			t.Parallel()
			c, err := Seal("风格不进入解密语义", "共享暗号", o.Value)
			if err != nil || !IsEnvelope(c) {
				t.Fatal(err)
			}
			if r := Open(c, []Key{{ID: "shared", Passphrase: "共享暗号"}}); r.Status != "plaintext" || r.Plaintext != "风格不进入解密语义" || r.KeyID != "shared" {
				t.Fatalf("%+v", r)
			}
		})
	}
}

func TestSealRejectsOversized(t *testing.T) {
	if !LengthSupported("普通长度", StyleQuote) {
		t.Fatal("普通长度应支持")
	}
	big := strings.Repeat("x", 600_000)
	if LengthSupported(big, StyleQuote) {
		t.Fatal("超长应拒绝")
	}
	if _, err := Seal(big, "k", StyleQuote); err == nil || err.Error() != "秘文内容过长" {
		t.Fatal(err)
	}
}

func TestOpenKeyOrderLockedNotSecret(t *testing.T) {
	c, _ := Seal("下午茶谁去买", "八卦频道", StyleClassic)
	if !strings.HasPrefix(c, "「话说") || !strings.HasSuffix(c, "。」") || !regexp.MustCompile(`[，、；。]`).MatchString(c) {
		t.Fatal(c)
	}
	r := Open(c, []Key{{ID: "wrong", Passphrase: "别的暗号"}, {ID: "right", Label: "同事群", Passphrase: "八卦频道"}})
	if r != (OpenResult{Status: "plaintext", Plaintext: "下午茶谁去买", KeyID: "right", KeyLabel: "同事群"}) {
		t.Fatalf("%+v", r)
	}
	if r := Open(c, []Key{{ID: "b", Passphrase: "钥B"}}); r != (OpenResult{Status: "locked"}) {
		t.Fatalf("%+v", r)
	}
	if r := Open(c, nil); r.Status != "locked" {
		t.Fatalf("%+v", r)
	}
	if r := Open("今晚一起吃火锅吗", []Key{{ID: "a", Passphrase: "k"}}); r != (OpenResult{Status: "not-secret"}) {
		t.Fatalf("%+v", r)
	}
}

func TestEstimateCipherLength(t *testing.T) {
	for _, text := range []string{"短", "下午茶谁去买单", "这是一条比较长的消息内容大概三十个字左右用来验证估算精度啊"} {
		c, _ := Seal(text, "k", StyleClassic)
		actual := utf8.RuneCountInString(c)
		if d := float64(EstimateLength(text, StyleClassic)-actual) / float64(actual); d >= 0.05 || d <= -0.05 {
			t.Fatalf("%q 偏差 %.3f", text, d)
		}
	}
	text := "这是一条用于估算不同秘文外观长度的内容"
	for _, o := range StyleOptions {
		c, _ := Seal(text, "k", o.Value)
		actual, est := utf8.RuneCountInString(c), EstimateLength(text, o.Value)
		if o.Value == StyleCode {
			if est < actual || est-actual >= 64 {
				t.Fatalf("code %d vs %d", est, actual)
			}
		} else if d := float64(est-actual) / float64(actual); d >= 0.12 || d <= -0.12 {
			t.Fatalf("%s %d vs %d", o.Value, est, actual)
		}
	}
}

func TestIsEnvelopeAndCorruptWrappers(t *testing.T) {
	c, _ := Seal("x", "k", StyleClassic)
	if !IsEnvelope(c) || IsEnvelope("普通聊天内容而已") || IsEnvelope("「随便写点什么」") {
		t.Fatal("IsEnvelope 判定错误")
	}
	for _, text := range []string{
		`const cacheSnapshot = "「话说」";`,
		"[debug] cache.snapshot=「话说一」",
		"> 「普通摘录」",
		`const cacheSnapshot = "普通文本";`,
	} {
		if IsEnvelope(text) || Open(text, []Key{{ID: "k", Passphrase: "k"}}).Status != "not-secret" {
			t.Fatal(text)
		}
	}
}

func TestFingerprintStableAcrossStyles(t *testing.T) {
	c, _ := Seal("避免包装规范化后重复", "k", StyleClassic)
	b := decodeChinese(c)
	var first string
	for i, o := range StyleOptions {
		fp, ok := Fingerprint(mustEncode(t, b, o.Value))
		if !ok || (i > 0 && fp != first) {
			t.Fatalf("%s 指纹不一致", o.Value)
		}
		first = fp
	}
	if !regexp.MustCompile(`^[0-9a-f]+$`).MatchString(first) {
		t.Fatal(first)
	}
	if _, ok := Fingerprint("普通文本"); ok {
		t.Fatal("普通文本不应有指纹")
	}
}
