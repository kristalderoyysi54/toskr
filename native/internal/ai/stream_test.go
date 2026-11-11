package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func streamServer(t *testing.T, h http.HandlerFunc) Config {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return Config{Endpoint: srv.URL, Key: "k", Model: "m"}
}

func TestRewriteStream(t *testing.T) {
	cfg := streamServer(t, func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &req)
		if req["stream"] != true || r.URL.Path != "/v1/chat/completions" {
			t.Errorf("请求 %s %v", r.URL.Path, req["stream"])
		}
		w.Header().Set("Content-Type", "text/event-stream")
		for _, d := range []string{"你", "好，", "世界"} {
			b, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": d}}}})
			fmt.Fprintf(w, "data: %s\n\n", b)
			w.(http.Flusher).Flush()
		}
		fmt.Fprint(w, ": keep-alive\n\ndata: {\"choices\":[{\"delta\":{}}]}\n\ndata: [DONE]\n\n")
	})
	var got []string
	out, err := RewriteStream(context.Background(), cfg, "润色", "原文", func(d string) { got = append(got, d) })
	if err != nil || out != "你好，世界" || strings.Join(got, "|") != "你|好，|世界" {
		t.Fatalf("%q %v %v", out, err, got)
	}
}

// 服务端忽略 stream 返回整段 JSON；或带 stream 就 400：都退回非流式，结果一次性给 onDelta。
func TestRewriteStreamFallbacks(t *testing.T) {
	plain := streamServer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"choices":[{"message":{"role":"assistant","content":" 整段结果 "}}]}`)
	})
	var got string
	if out, err := RewriteStream(context.Background(), plain, "i", "t", func(d string) { got += d }); err != nil || out != "整段结果" || got != "整段结果" {
		t.Fatalf("%q %q %v", out, got, err)
	}
	calls := 0
	reject := streamServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		raw, _ := io.ReadAll(r.Body)
		if strings.Contains(string(raw), `"stream":true`) {
			http.Error(w, `{"error":{"message":"stream not supported"}}`, http.StatusBadRequest)
			return
		}
		fmt.Fprint(w, `{"choices":[{"message":{"content":"非流式结果"}}]}`)
	})
	got = ""
	if out, err := RewriteStream(context.Background(), reject, "i", "t", func(d string) { got += d }); err != nil || out != "非流式结果" || got != out || calls != 2 {
		t.Fatalf("%q %q %v calls=%d", out, got, err, calls)
	}
	bad := streamServer(t, func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"error":{"message":"invalid key"}}`, http.StatusUnauthorized)
	})
	if _, err := RewriteStream(context.Background(), bad, "i", "t", nil); err == nil || !strings.Contains(err.Error(), "invalid key") {
		t.Fatalf("%v", err)
	}
	if _, err := RewriteStream(context.Background(), Config{Endpoint: plain.Endpoint, Model: "m"}, "i", "t", nil); err != ErrNoKey {
		t.Fatalf("%v", err)
	}
}

// 取消：流到一半取消，返回 context 错误。
func TestRewriteStreamCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cfg := streamServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"半\"}}]}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	})
	_, err := RewriteStream(ctx, cfg, "i", "t", func(string) { cancel() })
	if err == nil {
		t.Fatal("取消应返回错误")
	}
}
