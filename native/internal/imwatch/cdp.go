package imwatch

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/net/websocket"
)

// 对应 Tauri 版 message_watch_cdp.rs：用户确认目标 IM 后，以调试端口重启它，经 CDP
// attach 主页面，注入与手动粘贴同一份只读桥脚本（transport=cdp），消息走 binding 回传。

const bindingName = "__toskrEmit"

// cdpOrigin：Chromium 111+ 拒绝带 Origin 的调试连接，除非启动参数显式放行。
const cdpOrigin = "http://127.0.0.1"

// Profile 是用户「探测并确认」得到的目标 IM（不预置任何具体应用）。
type Profile struct {
	BundleID string `json:"bundleId"`
	BinPath  string `json:"binPath"`
}

// Validate 只接受 .app 包内 Contents/MacOS 下的主可执行文件。
func (p Profile) Validate() error {
	if p.BundleID == "" || !filepath.IsAbs(p.BinPath) {
		return errors.New("目标 IM 档案不完整，请重新探测")
	}
	macos := filepath.Dir(p.BinPath)
	contents := filepath.Dir(macos)
	if filepath.Base(macos) != "MacOS" || filepath.Base(contents) != "Contents" || filepath.Ext(filepath.Dir(contents)) != ".app" {
		return errors.New("仅支持应用包内的主可执行文件")
	}
	return nil
}

func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// Launch 以调试端口直起 IM 主二进制，返回浏览器级 ws 地址与子进程。
// 调用方负责先让正在运行的 IM 优雅退出。
func Launch(p Profile, timeout time.Duration) (string, *exec.Cmd, error) {
	if err := p.Validate(); err != nil {
		return "", nil, err
	}
	port, err := freePort()
	if err != nil {
		return "", nil, err
	}
	cmd := exec.Command(p.BinPath, fmt.Sprintf("--remote-debugging-port=%d", port), "--remote-allow-origins="+cdpOrigin)
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return "", nil, err
	}
	if err := cmd.Start(); err != nil {
		return "", nil, err
	}
	found := make(chan string, 1)
	go func() {
		sc := bufio.NewScanner(stderr)
		sent := false
		for sc.Scan() { // 读完以排空管道，避免子进程写 stderr 阻塞
			if i := strings.Index(sc.Text(), "ws://"); i >= 0 && !sent {
				found <- strings.TrimSpace(sc.Text()[i:])
				sent = true
			}
		}
	}()
	select {
	case ws := <-found:
		return ws, cmd, nil
	case <-time.After(timeout):
		_ = Terminate(cmd, 5*time.Second)
		return "", nil, errors.New("目标 IM 未在限定时间内打开调试通道")
	}
}

// Terminate 先 SIGTERM，超时再 SIGKILL。
func Terminate(cmd *exec.Cmd, grace time.Duration) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	_ = cmd.Process.Signal(syscall.SIGTERM)
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-done:
		return nil
	case <-time.After(grace):
		_ = cmd.Process.Kill()
		<-done
		return errors.New("目标 IM 未响应退出，已强制结束")
	}
}

type rpc struct {
	ID        int64           `json:"id,omitempty"`
	Method    string          `json:"method,omitempty"`
	Params    json.RawMessage `json:"params,omitempty"`
	SessionID string          `json:"sessionId,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
	Error     json.RawMessage `json:"error,omitempty"`
}

type cdpConn struct {
	ws      *websocket.Conn
	id      int64
	in      chan rpc
	readErr chan error
	session string
	onEvent func(rpc)
}

func dialCDP(wsURL string) (*cdpConn, error) {
	cfg, err := websocket.NewConfig(wsURL, cdpOrigin)
	if err != nil {
		return nil, err
	}
	cfg.Dialer = &net.Dialer{Timeout: 5 * time.Second}
	ws, err := websocket.DialConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("连接 CDP 失败：%w", err)
	}
	ws.MaxPayloadBytes = 16 << 20
	c := &cdpConn{ws: ws, in: make(chan rpc, 64), readErr: make(chan error, 1)}
	go func() {
		for {
			var text string
			if err := websocket.Message.Receive(ws, &text); err != nil {
				c.readErr <- err
				return
			}
			var m rpc
			if json.Unmarshal([]byte(text), &m) == nil {
				c.in <- m
			}
		}
	}()
	return c, nil
}

func (c *cdpConn) send(method string, params any, session string) (int64, error) {
	c.id++
	p, _ := json.Marshal(params)
	raw, _ := json.Marshal(rpc{ID: c.id, Method: method, Params: p, SessionID: session})
	return c.id, websocket.Message.Send(c.ws, string(raw))
}

// call 发命令并等待同 id 的响应；期间到达的事件交给 onEvent，不丢 bindingCalled。
func (c *cdpConn) call(ctx context.Context, method string, params any, session string) (json.RawMessage, error) {
	id, err := c.send(method, params, session)
	if err != nil {
		return nil, err
	}
	timeout := time.After(10 * time.Second)
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case err := <-c.readErr:
			return nil, fmt.Errorf("CDP 读失败：%w", err)
		case <-timeout:
			return nil, errors.New("CDP 命令响应超时：" + method)
		case m := <-c.in:
			if m.ID == id {
				if len(m.Error) > 0 {
					return nil, fmt.Errorf("CDP 命令失败：%s", m.Error)
				}
				return m.Result, nil
			}
			c.handle(m)
		}
	}
}

func (c *cdpConn) handle(m rpc) {
	if m.Method == "Runtime.executionContextCreated" && c.session != "" {
		_, _ = c.send("Runtime.addBinding", map[string]string{"name": bindingName}, c.session) // binding 随执行上下文走
	}
	if c.onEvent != nil {
		c.onEvent(m)
	}
}

// FindPageTarget 取首个 type=page 且 url 为 file:// 的目标（Electron IM 的主界面）。
func FindPageTarget(result json.RawMessage) string {
	var r struct {
		TargetInfos []struct {
			TargetID, Type, URL string
		} `json:"targetInfos"`
	}
	_ = json.Unmarshal(result, &r)
	for _, t := range r.TargetInfos {
		if t.Type == "page" && strings.HasPrefix(t.URL, "file://") {
			return t.TargetID
		}
	}
	return ""
}

// RunCDP 连接、注入并收消息，直到 ctx 取消或连接断开。
func (b *Bridge) RunCDP(ctx context.Context, wsURL, script string) error {
	c, err := dialCDP(wsURL)
	if err != nil {
		return err
	}
	defer c.ws.Close()
	c.onEvent = func(m rpc) {
		if m.Method != "Runtime.bindingCalled" {
			return
		}
		var p struct{ Name, Payload string }
		if json.Unmarshal(m.Params, &p) != nil || p.Name != bindingName {
			return
		}
		var msg Message
		if json.Unmarshal([]byte(p.Payload), &msg) == nil {
			_, _ = b.Accept(msg)
		}
	}
	target := ""
	for range 15 { // 页面加载稍慢，轮询等它注册
		res, err := c.call(ctx, "Target.getTargets", map[string]any{}, "")
		if err != nil {
			return err
		}
		if target = FindPageTarget(res); target != "" {
			break
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(time.Second):
		}
	}
	if target == "" {
		return errors.New("未找到 IM 页面（加载超时）")
	}
	res, err := c.call(ctx, "Target.attachToTarget", map[string]any{"targetId": target, "flatten": true}, "")
	if err != nil {
		return err
	}
	var att struct {
		SessionID string `json:"sessionId"`
	}
	if json.Unmarshal(res, &att) != nil || att.SessionID == "" {
		return errors.New("attach 未返回 sessionId")
	}
	c.session = att.SessionID
	for _, step := range []struct {
		method string
		params any
	}{
		{"Runtime.enable", map[string]any{}},
		{"Page.enable", map[string]any{}},
		{"Runtime.addBinding", map[string]string{"name": bindingName}},
		{"Page.addScriptToEvaluateOnNewDocument", map[string]string{"source": script}},
		{"Runtime.evaluate", map[string]any{"expression": script, "awaitPromise": false, "returnByValue": false}},
	} {
		if _, err := c.call(ctx, step.method, step.params, c.session); err != nil {
			return err
		}
	}
	b.mu.Lock()
	b.st.CDPConnected, b.st.Transport, b.st.LastError = true, "cdp", ""
	b.mu.Unlock()
	defer func() { b.mu.Lock(); b.st.CDPConnected = false; b.mu.Unlock() }()
	for {
		select {
		case <-ctx.Done():
			return nil
		case err := <-c.readErr:
			return fmt.Errorf("CDP 连接断开：%w", err)
		case m := <-c.in:
			c.handle(m)
		}
	}
}
