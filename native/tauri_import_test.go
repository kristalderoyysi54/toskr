package main

import (
	"bytes"
	hexenc "encoding/hex"
	"errors"
	"testing"
)

func TestParseKeychainKey(t *testing.T) {
	k := bytes.Repeat([]byte{0xab}, 32)
	if got, err := parseKeychainKey([]byte(hexenc.EncodeToString(k) + "\n")); err != nil || !bytes.Equal(got, k) {
		t.Fatal("十六进制输出", err)
	}
	if got, err := parseKeychainKey([]byte("abcdefghijklmnopqrstuvwxyz012345\n")); err != nil || len(got) != 32 {
		t.Fatal("可打印原值", err)
	}
	if _, err := parseKeychainKey([]byte("short")); err == nil {
		t.Fatal("格式不对应报错")
	}
}

// 取不到钥匙串授权：不动数据，给 warn 气泡。
func TestImportTauriDenied(t *testing.T) {
	a, _ := testApp(t, "原有")
	old := tauriKey
	tauriKey = func() ([]byte, error) { return nil, errors.New("没有取得钥匙串授权") }
	t.Cleanup(func() { tauriKey = old })
	done := make(chan error, 1)
	a.importTauri(func(_ string, err error) { done <- err })
	if err := <-done; err == nil || a.hudKind != "warn" || len(a.store.Notes()) != 1 {
		t.Fatalf("err=%v hud=%s", err, a.hudKind)
	}
}
