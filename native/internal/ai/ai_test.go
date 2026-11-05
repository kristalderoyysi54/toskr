package ai

import (
	"context"
	"encoding/json"
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
