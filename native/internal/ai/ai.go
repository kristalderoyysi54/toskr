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
	"slices"
	"strings"
	"time"
)

type Config struct {
	Endpoint string // Base URL，如 https://api.deepseek.com（带不带 /v1 都行）
	Key      string
	Model    string
	Off      bool // 设置里关了「AI 智能」：所有 AI 入口都不发请求（连接测试除外）
}

var (
	ErrNoKey       = errors.New("未配置 AI 密钥（设置 → AI）")
	ErrBadEndpoint = errors.New("AI 地址必须是 https（本机 http://localhost 除外）")
	ErrDisabled    = errors.New("AI 智能未启用（设置 → AI）")
)

// MaxInput 是单次请求的正文上限（字符）；超出截断，避免误把整段日志发出去。
const MaxInput = 12000

type message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

func (c Config) validate() (string, error) {
	if c.Off {
		return "", ErrDisabled
	}
	if strings.TrimSpace(c.Key) == "" {
		return "", ErrNoKey
	}
	return c.url("chat/completions")
}

// url 拼接口地址：与 Tauri 一致，Base URL 不带 /v1 时补上（https://api.deepseek.com → …/v1/chat/completions）；
// 原生版早期默认值带 /v1（https://api.openai.com/v1），两种写法都认。
func (c Config) url(suffix string) (string, error) {
	u, err := url.Parse(strings.TrimRight(strings.TrimSpace(c.Endpoint), "/"))
	if err != nil || u.Host == "" || u.User != nil {
		return "", ErrBadEndpoint
	}
	local := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"
	if u.Scheme != "https" && !(u.Scheme == "http" && local) {
		return "", ErrBadEndpoint
	}
	u.RawQuery, u.Fragment = "", ""
	if !strings.HasSuffix(u.Path, "/v1") {
		u.Path += "/v1"
	}
	return u.String() + "/" + suffix, nil
}

// ListModels 取服务端模型列表（GET /v1/models，同 Tauri ai_list_models），去重排序。
func ListModels(ctx context.Context, cfg Config) ([]string, error) {
	if strings.TrimSpace(cfg.Key) == "" {
		return nil, ErrNoKey
	}
	endpoint, err := cfg.url("models")
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	req.Header.Set("Authorization", "Bearer "+cfg.Key)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("AI 返回 %d", resp.StatusCode)
	}
	var out struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if json.Unmarshal(raw, &out) != nil {
		return nil, errors.New("模型列表响应非 JSON")
	}
	var ids []string
	for _, d := range out.Data {
		if d.ID != "" && !slices.Contains(ids, d.ID) {
			ids = append(ids, d.ID)
		}
	}
	if len(ids) == 0 {
		return nil, errors.New("模型列表响应格式异常")
	}
	slices.Sort(ids)
	return ids, nil
}

// Test 发一次最小请求（同 Tauri testAiConnection）。
func Test(ctx context.Context, cfg Config) error {
	cfg.Off = false
	_, err := Rewrite(ctx, cfg, "你是连通性测试助手。", "收到请只回复：OK")
	return err
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
