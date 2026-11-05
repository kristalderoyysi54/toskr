// Package ai 是 OpenAI 兼容的 Chat Completions 客户端（对应 Tauri 版 ai.rs 的文本改写部分）。
package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Config struct {
	Endpoint string // 如 https://api.openai.com/v1
	Key      string
	Model    string
}

var (
	ErrNoKey       = errors.New("未配置 AI 密钥（设置 → AI）")
	ErrBadEndpoint = errors.New("AI 地址必须是 https（本机 http://localhost 除外）")
)

// MaxInput 是单次请求的正文上限（字符）；超出截断，避免误把整段日志发出去。
const MaxInput = 12000

type message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

func (c Config) validate() (string, error) {
	if strings.TrimSpace(c.Key) == "" {
		return "", ErrNoKey
	}
	u, err := url.Parse(strings.TrimRight(c.Endpoint, "/"))
	if err != nil || u.Host == "" {
		return "", ErrBadEndpoint
	}
	local := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1"
	if u.Scheme != "https" && !(u.Scheme == "http" && local) {
		return "", ErrBadEndpoint
	}
	return u.String() + "/chat/completions", nil
}

// Rewrite 按 instruction 改写 text，返回模型输出。
func Rewrite(ctx context.Context, cfg Config, instruction, text string) (string, error) {
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
	})
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+cfg.Key)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	var out struct {
		Choices []struct {
			Message message `json:"message"`
		} `json:"choices"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(raw, &out)
	if resp.StatusCode != http.StatusOK {
		if out.Error != nil && out.Error.Message != "" {
			return "", fmt.Errorf("AI 返回 %d：%s", resp.StatusCode, out.Error.Message)
		}
		return "", fmt.Errorf("AI 返回 %d", resp.StatusCode)
	}
	if len(out.Choices) == 0 || strings.TrimSpace(out.Choices[0].Message.Content) == "" {
		return "", errors.New("AI 没有返回内容")
	}
	return strings.TrimSpace(out.Choices[0].Message.Content), nil
}
