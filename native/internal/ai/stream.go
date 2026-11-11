package ai

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// streamIdle：流式请求里两次数据之间最长等多久（整次请求不设总时限，长文可以慢慢出）。
const streamIdle = 60 * time.Second

// RewriteStream 同 Rewrite，但用 stream: true 请求，每收到一段增量就调 onDelta（在请求 goroutine 上）。
// 服务端不支持流式时自动退回：返回普通 JSON 就按整段处理；带 stream 参数被 400 / 404 / 422 拒绝就改发非流式请求。
// 返回完整结果（已去首尾空白）。
func RewriteStream(ctx context.Context, cfg Config, instruction, text string, onDelta func(string)) (string, error) {
	endpoint, err := cfg.validate()
	if err != nil {
		return "", err
	}
	if r := []rune(text); len(r) > MaxInput {
		text = string(r[:MaxInput])
	}
	body, _ := json.Marshal(map[string]any{
		"model": cfg.Model,
		"messages": []message{
			{"system", instruction + "\n只输出结果本身，不要解释、不要加引号。"},
			{"user", text},
		},
		"temperature": 0.3,
		"stream":      true,
	})
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	idle := time.AfterFunc(streamIdle, cancel)
	defer idle.Stop()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Authorization", "Bearer "+cfg.Key)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		switch resp.StatusCode {
		case http.StatusBadRequest, http.StatusNotFound, http.StatusUnprocessableEntity:
			if out, err2 := Rewrite(ctx, cfg, instruction, text); err2 == nil { // 可能只是不认 stream 参数
				if onDelta != nil {
					onDelta(out)
				}
				return out, nil
			}
		}
		var e struct {
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(raw, &e)
		if e.Error != nil && e.Error.Message != "" {
			return "", fmt.Errorf("AI 返回 %d：%s", resp.StatusCode, e.Error.Message)
		}
		return "", fmt.Errorf("AI 返回 %d", resp.StatusCode)
	}
	if !strings.Contains(resp.Header.Get("Content-Type"), "event-stream") { // 忽略了 stream：整段 JSON
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
		var out struct {
			Choices []struct {
				Message message `json:"message"`
			} `json:"choices"`
		}
		_ = json.Unmarshal(raw, &out)
		if len(out.Choices) == 0 || strings.TrimSpace(out.Choices[0].Message.Content) == "" {
			return "", errors.New("AI 没有返回内容")
		}
		res := strings.TrimSpace(out.Choices[0].Message.Content)
		if onDelta != nil {
			onDelta(res)
		}
		return res, nil
	}
	var full strings.Builder
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for sc.Scan() {
		idle.Reset(streamIdle)
		line := strings.TrimSpace(sc.Text())
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			break
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal([]byte(data), &chunk) != nil {
			continue
		}
		if chunk.Error != nil && chunk.Error.Message != "" {
			return "", errors.New("AI：" + chunk.Error.Message)
		}
		if len(chunk.Choices) == 0 || chunk.Choices[0].Delta.Content == "" {
			continue
		}
		d := chunk.Choices[0].Delta.Content
		full.WriteString(d)
		if onDelta != nil {
			onDelta(d)
		}
		if full.Len() > 4<<20 {
			break
		}
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if err := sc.Err(); err != nil {
		return "", err
	}
	res := strings.TrimSpace(full.String())
	if res == "" {
		return "", errors.New("AI 没有返回内容")
	}
	return res, nil
}
