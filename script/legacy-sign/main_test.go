package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 用随机钥对走一遍 签 → 验，再确认改一个字节 / 换 trusted comment 都会被拒。
func TestSignVerifyRoundTrip(t *testing.T) {
	pk, sk, _ := ed25519.GenerateKey(nil)
	k := secretKey{keyNum: [8]byte{1, 2, 3, 4, 5, 6, 7, 8}, sk: sk}
	p := publicKey{keyNum: k.keyNum, pk: pk}
	data := []byte("toskr update payload")
	sig := sign(k, data, "timestamp:1\tfile:Toskr.app.tar.gz")
	if err := verify(p, data, sig); err != nil {
		t.Fatal(err)
	}
	if verify(p, []byte("toskr update payloaD"), sig) == nil {
		t.Fatal("改过的文件不应通过")
	}
	text, _ := base64.StdEncoding.DecodeString(sig)
	forged := base64.StdEncoding.EncodeToString([]byte(strings.Replace(string(text), "timestamp:1", "timestamp:2", 1)))
	if verify(p, data, forged) == nil {
		t.Fatal("改过的 trusted comment 不应通过")
	}
}

func TestLegacyPubKeyParses(t *testing.T) {
	p, err := parsePublicKey(legacyPubKey)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.pk) != ed25519.PublicKeySize {
		t.Fatal("公钥长度不对")
	}
}

// 与 tauri CLI 对照：tauri CLI 用随机化 Ed25519 签名（同数据同时间戳两次签出不同），所以不比字节，比的是——
// 它签的真实发布物（LEGACY_SIGN_FIXTURE=<Toskr.app.tar.gz 路径>，旁边有 .sig）能过本实现的校验；
// 沿用原 trusted comment 用真实私钥（~/.tauri/toskr-updater.key）重签，除签名字节外逐行相同，且同样过校验。
// 旧版更新器所用 minisign-verify 0.2.5 的实测见 tasks/todo.md。缺任一项时跳过。
func TestTauriCLICompat(t *testing.T) {
	file := os.Getenv("LEGACY_SIGN_FIXTURE")
	home, _ := os.UserHomeDir()
	keyText, kerr := os.ReadFile(filepath.Join(home, ".tauri/toskr-updater.key"))
	if file == "" || kerr != nil {
		t.Skip("需要 LEGACY_SIGN_FIXTURE 与旧版更新私钥")
	}
	want, err := os.ReadFile(file + ".sig")
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	pub, _ := parsePublicKey(legacyPubKey)
	if err := verify(pub, data, string(want)); err != nil {
		t.Fatalf("tauri CLI 的签名没通过本实现的校验：%v", err)
	}
	k, err := parseSecretKey(string(keyText), "")
	if err != nil {
		t.Fatal(err)
	}
	if !pub.pk.Equal(k.sk.Public()) || pub.keyNum != k.keyNum {
		t.Fatal("私钥与锁定公钥不配对")
	}
	wantText, _ := base64.StdEncoding.DecodeString(string(want))
	wl := strings.Split(string(wantText), "\n")
	got := sign(k, data, strings.TrimPrefix(wl[2], "trusted comment: "))
	if err := verify(pub, data, got); err != nil {
		t.Fatal(err)
	}
	gotText, _ := base64.StdEncoding.DecodeString(got)
	gl := strings.Split(string(gotText), "\n")
	if len(gl) != len(wl) || gl[0] != wl[0] || gl[2] != wl[2] || gl[1][:12] != wl[1][:12] || len(gl[1]) != len(wl[1]) || len(gl[3]) != len(wl[3]) {
		t.Fatalf("格式与 tauri CLI 不一致\n got %q\nwant %q", gotText, wantText)
	}
}
