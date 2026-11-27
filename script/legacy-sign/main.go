// legacy-sign：给旧版（Tauri）更新器签 Toskr.app.tar.gz，替代 `tauri signer sign`。
//
// 旧版更新器只认旧版私钥（~/.tauri/toskr-updater.key）签的包，公钥烧在存量旧版里（legacyPubKey）。
// 格式与 tauri CLI 一致：私钥文件 = base64(minisign 私钥文本，scrypt 加密)；
// .sig = base64(minisign 签名文本)，预哈希（BLAKE2b-512）的 ED 签名，trusted comment 为
// "timestamp:<秒>\tfile:<文件名>"。tauri CLI 的签名带随机数，与本实现不会逐字节相同，但都能过旧版更新器的校验。
//
// 用法: go run . -key ~/.tauri/toskr-updater.key [-password ""] [-trusted "…"] <文件>   → 写 <文件>.sig
package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/crypto/blake2b"
	"golang.org/x/crypto/scrypt"
)

// legacyPubKey：旧版 src-tauri/tauri.conf.json 的 plugins.updater.pubkey（已烧进存量旧版，不能换）。
const legacyPubKey = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDQzM0YwQjU2MDcwRUM5MzYKUldRMnlRNEhWZ3MvUXdwM2svc2RTcVpkcnlaV08zaXZ2UThPVjAvdncwVW1pRDRtbWoxOVUwSW4K"

const untrustedComment = "signature from tauri secret key"

type secretKey struct {
	keyNum [8]byte
	sk     ed25519.PrivateKey
}

type publicKey struct {
	keyNum [8]byte
	pk     ed25519.PublicKey
}

// decodeBox：base64 包着的 minisign 文本，取第 2 行（base64 载荷）解码。
func decodeBox(b64 string) ([]byte, error) {
	text, err := base64.StdEncoding.DecodeString(strings.TrimSpace(b64))
	if err != nil {
		return nil, fmt.Errorf("外层 base64：%w", err)
	}
	lines := strings.Split(strings.TrimRight(string(text), "\n"), "\n")
	if len(lines) < 2 || !strings.HasPrefix(lines[0], "untrusted comment: ") {
		return nil, errors.New("不是 minisign 格式")
	}
	return base64.StdEncoding.DecodeString(strings.TrimSpace(lines[1]))
}

func parsePublicKey(b64 string) (publicKey, error) {
	var p publicKey
	raw, err := decodeBox(b64)
	if err != nil {
		return p, err
	}
	if len(raw) != 42 || string(raw[:2]) != "Ed" {
		return p, errors.New("公钥格式不对")
	}
	copy(p.keyNum[:], raw[2:10])
	p.pk = ed25519.PublicKey(raw[10:])
	return p, nil
}

// parseSecretKey：sig_alg(2) kdf_alg(2) chk_alg(2) salt(32) opslimit(8) memlimit(8) 密文(keynum 8 + sk 64 + 校验 32)。
func parseSecretKey(b64, password string) (secretKey, error) {
	var s secretKey
	raw, err := decodeBox(b64)
	if err != nil {
		return s, err
	}
	if len(raw) != 158 || string(raw[:2]) != "Ed" || string(raw[4:6]) != "B2" {
		return s, errors.New("私钥格式不对")
	}
	body := bytes.Clone(raw[54:])
	defer clear(body)
	switch string(raw[2:4]) {
	case "Sc":
		ops, mem := binary.LittleEndian.Uint64(raw[38:46]), binary.LittleEndian.Uint64(raw[46:54])
		logN, r, p := pickParams(ops, mem)
		stream, err := scrypt.Key([]byte(password), raw[6:38], 1<<logN, r, p, len(body))
		if err != nil {
			return s, err
		}
		for i := range body {
			body[i] ^= stream[i]
		}
		clear(stream)
	case "\x00\x00":
	default:
		return s, errors.New("不认识的私钥加密方式")
	}
	h, _ := blake2b.New256(nil)
	h.Write(raw[:2])
	h.Write(body[:72])
	if subtle.ConstantTimeCompare(h.Sum(nil), body[72:]) != 1 {
		return s, errors.New("私钥校验失败（口令不对或文件损坏）")
	}
	copy(s.keyNum[:], body[:8])
	s.sk = ed25519.PrivateKey(bytes.Clone(body[8:72]))
	return s, nil
}

// pickParams：libsodium crypto_pwhash_scryptsalsa208sha256 由 opslimit / memlimit 推 N、r、p 的规则（minisign 同款）。
func pickParams(ops, mem uint64) (logN uint, r, p int) {
	ops = max(ops, 32768)
	r = 8
	var maxN uint64
	if ops < mem/32 {
		p = 1
		maxN = ops / uint64(r*4)
	} else {
		maxN = mem / uint64(r*128)
	}
	for logN = 1; logN < 63; logN++ {
		if uint64(1)<<logN > maxN/2 {
			break
		}
	}
	if ops >= mem/32 {
		maxrp := min((ops/4)/(uint64(1)<<logN), 0x3fffffff)
		p = int(maxrp) / r
	}
	return logN, r, p
}

// sign：返回 .sig 文件内容（base64 包着的 minisign 签名文本）。
func sign(k secretKey, data []byte, trusted string) string {
	digest := blake2b.Sum512(data)
	sig := ed25519.Sign(k.sk, digest[:])
	global := ed25519.Sign(k.sk, append(bytes.Clone(sig), trusted...))
	line := append(append([]byte("ED"), k.keyNum[:]...), sig...)
	text := "untrusted comment: " + untrustedComment + "\n" +
		base64.StdEncoding.EncodeToString(line) + "\n" +
		"trusted comment: " + trusted + "\n" +
		base64.StdEncoding.EncodeToString(global) + "\n"
	return base64.StdEncoding.EncodeToString([]byte(text))
}

// verify：按旧版更新器（minisign verify）的口径核对 .sig。
func verify(p publicKey, data []byte, sigB64 string) error {
	text, err := base64.StdEncoding.DecodeString(strings.TrimSpace(sigB64))
	if err != nil {
		return err
	}
	lines := strings.Split(strings.TrimRight(string(text), "\n"), "\n")
	if len(lines) != 4 || !strings.HasPrefix(lines[2], "trusted comment: ") {
		return errors.New("签名格式不对")
	}
	line, err := base64.StdEncoding.DecodeString(lines[1])
	if err != nil || len(line) != 74 || string(line[:2]) != "ED" {
		return errors.New("签名格式不对")
	}
	if !bytes.Equal(line[2:10], p.keyNum[:]) {
		return errors.New("签名的 key id 与公钥不符")
	}
	digest := blake2b.Sum512(data)
	if !ed25519.Verify(p.pk, digest[:], line[10:]) {
		return errors.New("文件签名无效")
	}
	global, err := base64.StdEncoding.DecodeString(lines[3])
	if err != nil || !ed25519.Verify(p.pk, append(bytes.Clone(line[10:]), strings.TrimPrefix(lines[2], "trusted comment: ")...), global) {
		return errors.New("trusted comment 签名无效")
	}
	return nil
}

func run() error {
	keyPath := flag.String("key", "", "旧版更新私钥文件")
	password := flag.String("password", "", "私钥口令（旧版私钥为空口令）")
	trusted := flag.String("trusted", "", "指定 trusted comment（默认 timestamp:<现在>\\tfile:<文件名>；对照测试用）")
	flag.Parse()
	if *keyPath == "" || flag.NArg() != 1 {
		return errors.New("用法: legacy-sign -key <私钥> <文件>")
	}
	file := flag.Arg(0)
	keyText, err := os.ReadFile(*keyPath)
	if err != nil {
		return err
	}
	k, err := parseSecretKey(string(keyText), *password)
	if err != nil {
		return err
	}
	defer clear(k.sk)
	pub, err := parsePublicKey(legacyPubKey)
	if err != nil {
		return err
	}
	if k.keyNum != pub.keyNum || !pub.pk.Equal(k.sk.Public()) {
		return errors.New("私钥与旧版更新器锁定的公钥不配对：存量旧版会拒收这个签名")
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	tc := *trusted
	if tc == "" {
		tc = fmt.Sprintf("timestamp:%d\tfile:%s", time.Now().Unix(), filepath.Base(file))
	}
	out := sign(k, data, tc)
	if err := verify(pub, data, out); err != nil {
		return fmt.Errorf("签完自验失败：%w", err)
	}
	return os.WriteFile(file+".sig", []byte(out), 0o644)
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "legacy-sign:", err)
		os.Exit(1)
	}
}
