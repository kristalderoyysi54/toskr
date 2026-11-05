package main

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"

	"github.com/toskr/native/internal/macos"
)

// 钥匙串授权绑定在调用方的 CDHash 上（自签证书没有 Team ID，分区只能按 cdhash），主程序每次重编译都会变，
// 所以每次打包后首次启动都要授权。数据密钥改由固定产物 Contents/Resources/com.toskr.native.keychain-helper 读写：
// 它的二进制与签名参数不变，mygo 打包重签后 CDHash 恒定，授权一次之后主程序怎么重编译都不再弹窗。
// 协议与 Tauri 的 keychain_broker 相同：socketpair 交换 hello → 双方以内核 audit token 验明对端 → 单次请求。
//
// helperCDHash 是打包后（mygo 以 com.toskr.native 标识重签）包内 arm64 切片的 CDHash；
// 重新运行 keychain-helper/build.sh 后必须同步更新，否则拒绝访问（不回退到主进程直读，避免反复授权）。
const (
	helperName   = "com.toskr.native.keychain-helper"
	helperCDHash = "fc4feefa9eb2f2264085822ed17e4a383fb61d04"
	helperHello  = "TSKKEY01"
	certLeaf     = "6e960d8b61e1fc9c534e41cb812803d07e85e87b"

	errSecItemNotFound = -25300
	errSecUserCanceled = -128
)

var errHelperMissing = errors.New("内置密钥辅助程序不存在")

// helperPath 是包内辅助程序的路径（开发态 / 测试时不存在）。
func helperPath() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	p := filepath.Join(filepath.Dir(exe), "..", "Resources", helperName)
	if _, err := os.Stat(p); err != nil {
		return "", errHelperMissing
	}
	return p, nil
}

type helperResponse struct {
	Status int32   `json:"status"`
	Value  *string `json:"value"`
}

// helperRequest 起一次辅助程序，执行 load / store，返回钥匙串状态码与读到的值。
func helperRequest(path, op string, value []byte) (int32, []byte, error) {
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		return 0, nil, err
	}
	syscall.CloseOnExec(fds[0])
	if err := syscall.SetNonblock(fds[0], true); err != nil {
		syscall.Close(fds[0])
		syscall.Close(fds[1])
		return 0, nil, err
	}
	conn := os.NewFile(uintptr(fds[0]), "keychain-helper")
	child := os.NewFile(uintptr(fds[1]), "keychain-helper-child")
	defer conn.Close()
	cmd := exec.Command(path)
	cmd.Stdin, cmd.Stdout = child, child // 辅助程序要求 stdin / stdout 是同一个 Unix socket
	if err := cmd.Start(); err != nil {
		child.Close()
		return 0, nil, err
	}
	child.Close()
	defer func() { _ = cmd.Wait() }()
	defer func() {
		if cmd.ProcessState == nil {
			_ = cmd.Process.Kill()
		}
	}()

	// 授权弹窗等待用户时辅助程序会阻塞在钥匙串调用上，留足时间（辅助程序自身 IO 超时 5s 只管握手与收发）
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	hello := make([]byte, len(helperHello))
	if _, err := io.ReadFull(conn, hello); err != nil || string(hello) != helperHello {
		return 0, nil, fmt.Errorf("辅助程序握手失败：%v", err)
	}
	if _, err := conn.Write([]byte(helperHello)); err != nil {
		return 0, nil, err
	}
	// 对端身份：同一证书、固定 CDHash 的辅助程序，且就是刚起的子进程
	var token []byte
	var tokErr error
	if rc, err := conn.SyscallConn(); err == nil {
		_ = rc.Control(func(fd uintptr) { token, tokErr = macos.PeerAuditToken(fd) })
	} else {
		tokErr = err
	}
	if tokErr != nil {
		return 0, nil, tokErr
	}
	if pid := int(binary.LittleEndian.Uint32(token[20:24])); pid != cmd.Process.Pid { // audit_token_t.val[5] = pid
		return 0, nil, fmt.Errorf("辅助程序身份不符：pid %d ≠ %d", pid, cmd.Process.Pid)
	}
	req := fmt.Sprintf(`identifier "com.toskr.native" and certificate leaf = H"%s" and cdhash H"%s"`, certLeaf, helperCDHash)
	if err := macos.CheckAuditToken(token, req); err != nil {
		return 0, nil, fmt.Errorf("辅助程序身份校验失败，已停止访问钥匙串：%w", err)
	}

	body := map[string]any{"version": 1, "slot": "data", "operation": op, "interactive": true}
	if value != nil {
		body["value"] = base64.StdEncoding.EncodeToString(value)
	}
	frame, _ := json.Marshal(body)
	head := make([]byte, 4)
	binary.BigEndian.PutUint32(head, uint32(len(frame)))
	if _, err := conn.Write(append(head, frame...)); err != nil {
		return 0, nil, err
	}
	_ = conn.SetDeadline(time.Now().Add(5 * time.Minute)) // 等用户在授权弹窗里点选
	if _, err := io.ReadFull(conn, head); err != nil {
		return 0, nil, fmt.Errorf("辅助程序无响应：%v", err)
	}
	n := binary.BigEndian.Uint32(head)
	if n == 0 || n > 64*1024 {
		return 0, nil, errors.New("辅助程序返回无效数据")
	}
	raw := make([]byte, n)
	if _, err := io.ReadFull(conn, raw); err != nil {
		return 0, nil, err
	}
	var resp helperResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		return 0, nil, errors.New("辅助程序返回无效数据")
	}
	if resp.Status != 0 || resp.Value == nil {
		return resp.Status, nil, nil
	}
	got, err := base64.StdEncoding.DecodeString(*resp.Value)
	if err != nil || len(got) != 32 {
		return 0, nil, errors.New("辅助程序返回无效密钥")
	}
	return 0, got, nil
}

// helperDataKey 经辅助程序取数据密钥；首次运行（数据文件不存在）生成并存入。
func helperDataKey(path string, fresh bool, gen func() ([]byte, error)) ([]byte, error) {
	st, key, err := helperRequest(path, "load", nil)
	switch {
	case err != nil:
		return nil, err
	case st == 0:
		return key, nil
	case st == errSecUserCanceled:
		return nil, errors.New("已取消钥匙串授权：Toskr Native 需要读取数据密钥才能打开加密数据，请重新打开并点「始终允许」")
	case st != errSecItemNotFound:
		return nil, fmt.Errorf("无法访问钥匙串（%d）：请解锁或允许 Toskr Native 密钥服务后重试", st)
	case !fresh:
		return nil, errors.New("钥匙串里没有数据密钥，但数据文件已存在：拒绝新建密钥覆盖")
	}
	if key, err = gen(); err != nil {
		return nil, err
	}
	if st, _, err = helperRequest(path, "store", key); err != nil {
		return nil, err
	} else if st != 0 {
		return nil, fmt.Errorf("无法写入钥匙串（%d）", st)
	}
	return key, nil
}
