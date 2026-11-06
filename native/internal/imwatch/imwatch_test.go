package imwatch

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/net/websocket"
)

// 测试用「加密」：可逆异或，验证账本不落明文、读回走 open。
func xor(b []byte) ([]byte, error) {
	out := bytes.Clone(b)
	for i := range out {
		out[i] ^= 0x5a
	}
	return out, nil
}

func msg(id string) Message {
	yes := true
	return Message{BridgeVersion: 1, ConversationID: "g1", MessageID: id, ConversationName: "项目群", SenderUID: "u9",
		SenderName: "张三", MentionedSelf: true, IsGroup: &yes, Text: "@我 明天发版", CapturedAtMs: 1}
}

func TestHTTPBridgeAcceptsDedupsAndSealsLedger(t *testing.T) {
	dir := t.TempDir()
	b := New(dir, xor, xor)
	var got []Message
	b.OnMsg = func(m Message) { got = append(got, m) }
	ep, err := b.Start()
	if err != nil || !strings.HasPrefix(ep, "http://127.0.0.1:") || !strings.Contains(ep, "/v1/im/") {
		t.Fatalf("%s %v", ep, err)
	}
	defer b.Stop()
	post := func(m Message) int {
		raw, _ := json.Marshal(m)
		resp, err := http.Post(ep, "application/json", bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	if post(msg("m1")) != 200 || post(msg("m1")) != 200 {
		t.Fatal("首条与重复都应 200")
	}
	bad := msg("m2")
	bad.MentionedSelf = false
	if post(bad) != 422 {
		t.Fatal("未命中关注条件应拒绝")
	}
	if len(got) != 1 || b.Status().Accepted != 1 || b.Status().Dupes != 1 {
		t.Fatalf("got=%d %+v", len(got), b.Status())
	}
	resp, _ := http.Post(strings.TrimSuffix(ep, ep[len(ep)-4:])+"0000", "application/json", strings.NewReader("{}"))
	if resp.StatusCode != 404 {
		t.Fatal("令牌不对必须 404")
	}
	raw, _ := os.ReadFile(filepath.Join(dir, LedgerFile))
	if bytes.Contains(raw, []byte("明天发版")) {
		t.Fatal("账本不得有明文")
	}
	rec, err := b.Recent(10)
	if err != nil || len(rec) != 1 || rec[0].Message.Text != "@我 明天发版" {
		t.Fatalf("%+v %v", rec, err)
	}
}

func TestValidateRejectsDirectMessagesAndOversize(t *testing.T) {
	m := msg("x")
	no := false
	m.IsGroup = &no
	if Validate(&m) == nil {
		t.Fatal("私聊必须拒绝")
	}
	m = msg("x")
	m.Context = make([]ContextItem, 9)
	if Validate(&m) == nil {
		t.Fatal("上下文过多必须拒绝")
	}
	m = msg("x\n")
	if Validate(&m) == nil {
		t.Fatal("标识含控制字符必须拒绝")
	}
}

func TestScriptFillsPlaceholders(t *testing.T) {
	s := Script("http://127.0.0.1:1/v1/im/t", "cdp", 1234, []Rule{{ID: "r1", Name: "发版", Enabled: true, Keywords: []string{"发版"}}})
	if strings.Contains(s, "__TOSKR_") {
		t.Fatal("占位符必须全部替换")
	}
	for _, want := range []string{`const TRANSPORT = "cdp"`, `const STARTED_AT = 1234`, `"keywords":["发版"]`, `const ENDPOINT = "http://127.0.0.1:1/v1/im/t"`} {
		if !strings.Contains(s, want) {
			t.Fatalf("缺 %s", want)
		}
	}
}

func TestFormatNote(t *testing.T) {
	m := msg("m1")
	m.OccurredAtMs = time.Date(2026, 11, 5, 9, 30, 0, 0, time.Local).UnixMilli()
	got := FormatNote(m, time.Now())
	if !strings.HasPrefix(got, "【项目群】\n张三 · @我 · 2026/11/5 09:30:00\n@我 明天发版") || !strings.HasSuffix(got, "消息标识：m1") {
		t.Fatalf("%q", got)
	}
}

func TestProfileValidate(t *testing.T) {
	if (Profile{BundleID: "x", BinPath: "/Applications/IM.app/Contents/MacOS/IM"}).Validate() != nil {
		t.Fatal("包内主二进制应通过")
	}
	if (Profile{BundleID: "x", BinPath: "/usr/bin/curl"}).Validate() == nil {
		t.Fatal("包外可执行文件必须拒绝")
	}
}

// 假 CDP 服务端：getTargets → attach → 5 步注入，然后推一条 bindingCalled。
func TestRunCDPInjectsAndReceivesBinding(t *testing.T) {
	var methods []string
	srv := httptest.NewServer(websocket.Handler(func(ws *websocket.Conn) {
		for {
			var text string
			if websocket.Message.Receive(ws, &text) != nil {
				return
			}
			var m rpc
			_ = json.Unmarshal([]byte(text), &m)
			methods = append(methods, m.Method)
			reply := map[string]any{"id": m.ID, "result": map[string]any{}}
			switch m.Method {
			case "Target.getTargets":
				reply["result"] = map[string]any{"targetInfos": []map[string]string{{"targetId": "devtools", "type": "page", "url": "devtools://x"}, {"targetId": "main", "type": "page", "url": "file:///app/index.html"}}}
			case "Target.attachToTarget":
				reply["result"] = map[string]any{"sessionId": "S1"}
			}
			raw, _ := json.Marshal(reply)
			_ = websocket.Message.Send(ws, string(raw))
			if m.Method == "Runtime.evaluate" {
				payload, _ := json.Marshal(msg("cdp-1"))
				ev, _ := json.Marshal(map[string]any{"method": "Runtime.bindingCalled", "sessionId": "S1",
					"params": map[string]any{"name": bindingName, "payload": string(payload)}})
				_ = websocket.Message.Send(ws, string(ev))
			}
		}
	}))
	defer srv.Close()
	b := New(t.TempDir(), xor, xor)
	got := make(chan Message, 1)
	b.OnMsg = func(m Message) { got <- m }
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- b.RunCDP(ctx, "ws"+strings.TrimPrefix(srv.URL, "http"), "/*bridge*/") }()
	select {
	case m := <-got:
		if m.MessageID != "cdp-1" {
			t.Fatal(m.MessageID)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("未收到 binding 消息，已发命令 %v", methods)
	}
	if !b.Status().CDPConnected {
		t.Fatal("注入完成后应标记已连接")
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	want := "Target.getTargets,Target.attachToTarget,Runtime.enable,Page.enable,Runtime.addBinding,Page.addScriptToEvaluateOnNewDocument,Runtime.evaluate"
	if strings.Join(methods, ",") != want {
		t.Fatalf("命令序列 %v", methods)
	}
}

// 实机：推推开着图片查看器时 pic-preview.html 排在主界面前面，自动接入不能注入到它。
func TestFindPageTargetPrefersMain(t *testing.T) {
	res := json.RawMessage(`{"targetInfos":[
		{"type":"page","url":"file:///Applications/T.app/Contents/Resources/app/dist/pic-preview.html?id=1","targetId":"pic"},
		{"type":"service_worker","url":"file:///sw.js","targetId":"sw"},
		{"type":"page","url":"file:///Applications/T.app/Contents/Resources/app/dist/index.html#/chat","targetId":"main"}]}`)
	if got := FindPageTarget(res); got != "main" {
		t.Fatal(got)
	}
	only := json.RawMessage(`{"targetInfos":[{"type":"page","url":"file:///a/pic-preview.html","targetId":"pic"},{"type":"page","url":"https://x","targetId":"web"}]}`)
	if got := FindPageTarget(only); got != "pic" {
		t.Fatal("只有辅助页时退回首个 file:// 页", got)
	}
	if FindPageTarget(json.RawMessage(`{}`)) != "" {
		t.Fatal("空")
	}
}
