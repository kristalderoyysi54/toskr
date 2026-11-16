package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/toskr/native/internal/ai"
	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// AI 请求的隐私闸：干净内容不打扰；含敏感内容必须确认，拒绝即不发请求；设置里关掉隐私检查 / 提示类别不影响 AI；扫不全直接拒。
func TestAIAuthorizeGate(t *testing.T) {
	a, _ := testApp(t)
	orig, prevLive := aiAsk, liveApp
	t.Cleanup(func() { aiAsk, liveApp = orig, prevLive })
	liveApp = a
	st := a.store.Settings()
	st.FirewallOff, st.FirewallDisabledWarn = true, []string{"nationalId"}
	_ = a.store.SetSettings(st)
	var asked []string
	answer := false
	aiAsk = func(s confirmSpec) bool { asked = append(asked, s.String()); return answer }

	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`))
	}))
	defer srv.Close()
	cfg := ai.Config{Endpoint: strings.Replace(srv.URL, "127.0.0.1", "localhost", 1), Key: "k", Model: "m", Purpose: "润色"}

	if out, err := ai.Rewrite(context.Background(), cfg, "润色", "今天下午三点开会"); err != nil || out != "ok" || len(asked) != 0 {
		t.Fatalf("干净内容直接发 %q %v asked=%d", out, err, len(asked))
	}
	token := strings.Join([]string{"gh", "p_", strings.Repeat("a1B2", 9)}, "")
	id := strings.Join([]string{"1101051949", "1002002", "9"}, "")
	_, err := ai.Rewrite(context.Background(), cfg, "润色", "令牌 "+token+" 证件 "+id)
	if !errors.Is(err, errAIDeclined) || hits != 1 {
		t.Fatalf("拒绝后不应发出 err=%v hits=%d", err, hits)
	}
	if m := asked[0]; !strings.Contains(m, "润色") || !strings.Contains(m, "AI 服务：localhost:") || strings.Contains(m, "/v1/") || !strings.Contains(m, "仅本次发送原文") || !strings.Contains(m, "密钥/凭据 1 处") || !strings.Contains(m, "身份证号 1 处") || strings.Contains(m, token) {
		t.Fatalf("确认框应写明用途、地址与命中类别（不含原文）：%q", m)
	}
	answer = true
	if _, err := ai.Rewrite(context.Background(), cfg, "润色", "令牌 "+token); err != nil || hits != 2 {
		t.Fatalf("同意后发出 err=%v hits=%d", err, hits)
	}
	if err := authorizeAI(ai.Request{User: strings.Repeat("x", 2*1024*1024+1)}); !errors.Is(err, errAITooLarge) || len(asked) != 2 {
		t.Fatalf("扫不全直接拒绝、不弹框 err=%v asked=%d", err, len(asked))
	}
}

// 隐私检查开着时超出扫描上限的卡不外发（同 Tauri PrivacyIncomplete）；关掉隐私检查照常发。
func TestSendBlocksUnscannableNote(t *testing.T) {
	a, tt := testApp(t)
	sys := &recSys{}
	a.sys = sys
	a.target = macos.FrontApp{PID: 42, Name: "Cursor"}
	big := store.Note{ID: "big", Section: store.SectionInbox, Text: strings.Repeat("x", 2*1024*1024+1)} // 不入库：列表不排版 2MB 卡（入库时单测 575s）
	a.send([]store.Note{big})
	tt.Frame()
	if len(sys.sent()) != 0 || len(a.pending) != 0 || a.hudText != tr("发送中止：文本超出本地隐私扫描上限，无法在发送前复核") {
		t.Fatalf("应中止 sent=%d pending=%d hud=%q", len(sys.sent()), len(a.pending), a.hudText)
	}
	st := a.store.Settings()
	st.FirewallOff = true
	_ = a.store.SetSettings(st)
	a.send([]store.Note{big})
	waitFor(t, func() bool { tt.Frame(); return len(sys.sent()) > 0 })
}

// 确认窗「内容」行：有自定义标题用标题，否则首个非空行；敏感片段打码、长文截断；没有内容就不显示这一行。
func TestAISubjectInConfirm(t *testing.T) {
	orig := aiAsk
	t.Cleanup(func() { aiAsk = orig })
	token := strings.Join([]string{"gh", "p_", strings.Repeat("a1B2", 9)}, "")
	if got := aiSubject("周报草稿", "第一行\n"+token); got != "周报草稿" {
		t.Fatalf("有标题用标题 %q", got)
	}
	if got := aiSubject("", "\n  令牌 "+token+" 结尾\n第二行"); strings.Contains(got, token) || got != "令牌 •••• 结尾" {
		t.Fatalf("首行打码 %q", got)
	}
	if got := aiSubject("", strings.Repeat("字", 50)); got != strings.Repeat("字", 40)+"…" {
		t.Fatalf("截到 40 字 %q", got)
	}
	var spec confirmSpec
	aiAsk = func(s confirmSpec) bool { spec = s; return false }
	_ = authorizeAI(ai.Request{Purpose: "润色", Subject: "周报草稿", Endpoint: "https://api.example.com/v1/chat/completions", User: "令牌 " + token})
	if spec.facts[0].label != "内容" || spec.facts[0].value != "周报草稿" {
		t.Fatalf("首行应是内容 %+v", spec.facts)
	}
	_ = authorizeAI(ai.Request{Purpose: "润色", Endpoint: "https://api.example.com/v1/chat/completions", User: "令牌 " + token})
	if spec.facts[0].label == "内容" {
		t.Fatalf("没有内容不显示这一行 %+v", spec.facts)
	}
}
