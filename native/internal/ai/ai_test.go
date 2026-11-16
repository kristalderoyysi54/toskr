package ai

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRewriteSendsBearerAndParsesReply(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer k" {
			w.WriteHeader(401)
			_, _ = w.Write([]byte(`{"error":{"message":"bad auth"}}`))
			return
		}
		var body struct {
			Model    string `json:"model"`
			Messages []message
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Model != "m" || body.Messages[1].Content != "原文" {
			w.WriteHeader(400)
			return
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"  改写后 \n"}}]}`))
	}))
	defer srv.Close()
	ep := strings.Replace(srv.URL, "127.0.0.1", "localhost", 1) + "/v1"
	got, err := Rewrite(context.Background(), Config{Endpoint: ep, Key: "k", Model: "m"}, "润色", "原文")
	if err != nil || got != "改写后" {
		t.Fatalf("%q %v", got, err)
	}
	_, err = Rewrite(context.Background(), Config{Endpoint: ep, Key: "wrong", Model: "m"}, "润色", "原文")
	if err == nil || !strings.Contains(err.Error(), "bad auth") {
		t.Fatalf("应带上服务端错误信息：%v", err)
	}
}

func TestRewriteRejectsMissingKeyAndPlainHTTP(t *testing.T) {
	if _, err := Rewrite(context.Background(), Config{Endpoint: "https://x", Model: "m"}, "", "x"); err != ErrNoKey {
		t.Fatal(err)
	}
	if _, err := Rewrite(context.Background(), Config{Endpoint: "http://api.example.com/v1", Key: "k"}, "", "x"); err != ErrBadEndpoint {
		t.Fatal("非本机 http 必须拒绝（密钥会明文传输）")
	}
}

func TestEndpointWithOrWithoutV1(t *testing.T) {
	for in, want := range map[string]string{
		"https://api.deepseek.com":                       "https://api.deepseek.com/v1/chat/completions",
		"https://api.openai.com/v1/":                     "https://api.openai.com/v1/chat/completions",
		"https://dashscope.aliyuncs.com/compatible-mode": "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
		"http://127.0.0.1:3425":                          "http://127.0.0.1:3425/v1/chat/completions",
	} {
		if got, err := (Config{Endpoint: in}).url("chat/completions"); err != nil || got != want {
			t.Fatalf("%s → %s %v", in, got, err)
		}
	}
	if _, err := (Config{Endpoint: "https://u:p@api.example.com"}).url("models"); err != ErrBadEndpoint {
		t.Fatal("带用户名密码的地址应拒绝")
	}
}

func TestListModels(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" || r.Header.Get("Authorization") != "Bearer k" {
			http.Error(w, "bad", 400)
			return
		}
		_, _ = w.Write([]byte(`{"data":[{"id":"b"},{"id":"a"},{"id":"b"}]}`))
	}))
	defer srv.Close()
	ids, err := ListModels(context.Background(), Config{Endpoint: srv.URL, Key: "k"})
	if err != nil || strings.Join(ids, ",") != "a,b" {
		t.Fatal(ids, err)
	}
	if _, err := ListModels(context.Background(), Config{Endpoint: srv.URL}); err != ErrNoKey {
		t.Fatal(err)
	}
}

// 授权钩子：拒绝时一个请求都不发；看到的是截断后的真实内容；流式被拒退回非流式时不重复询问。
func TestAuthorizeGatesEveryRequest(t *testing.T) {
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["stream"] == true {
			w.WriteHeader(400)
			return
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"}}]}`))
	}))
	defer srv.Close()
	t.Cleanup(func() { Authorize = nil })
	cfg := Config{Endpoint: strings.Replace(srv.URL, "127.0.0.1", "localhost", 1), Key: "k", Model: "m", Purpose: "润色"}
	var seen []Request
	deny := errors.New("denied")
	Authorize = func(r Request) error { seen = append(seen, r); return deny }
	if _, err := Rewrite(context.Background(), cfg, "润色", strings.Repeat("字", MaxInput+5)); !errors.Is(err, deny) {
		t.Fatalf("拒绝应原样返回 %v", err)
	}
	if _, err := RewriteStream(context.Background(), cfg, "润色", "x", nil); !errors.Is(err, deny) {
		t.Fatalf("流式同样受控 %v", err)
	}
	if hits != 0 {
		t.Fatalf("拒绝后不应发请求 hits=%d", hits)
	}
	if r := seen[0]; r.Purpose != "润色" || !strings.HasSuffix(r.Endpoint, "/v1/chat/completions") || len([]rune(r.User)) != MaxInput || !strings.HasPrefix(r.System, "润色") {
		t.Fatalf("钩子应看到截断后的实发内容 %+v", r)
	}
	seen = nil
	Authorize = func(r Request) error { seen = append(seen, r); return nil }
	if out, err := RewriteStream(context.Background(), cfg, "润色", "x", nil); err != nil || out != "ok" {
		t.Fatalf("%q %v", out, err)
	}
	if len(seen) != 1 || hits != 2 {
		t.Fatalf("退回非流式不应再次授权 seen=%d hits=%d", len(seen), hits)
	}
}
