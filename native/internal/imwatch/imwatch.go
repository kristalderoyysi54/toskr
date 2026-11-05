// Package imwatch 是实验性 IM 消息桥（对应 Tauri 版 message_watch.rs）。
//
// 只在用户开启后监听 127.0.0.1 随机端口，路径带随机令牌；目标 IM 里运行的只读桥脚本
// （与 Tauri 版同一份，见 bridge.js）把客户端已判定为「@我 / 特别关注 / 命中组合规则」
// 的群消息送来。消息先校验、去重，再加密追加到 JSONL 账本，最后回调给应用。
// 本包不操作 IM 窗口，不调用任何已读 / 发送接口。
package imwatch

import (
	"bufio"
	"crypto/rand"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	BridgeVersion = 1
	LedgerFile    = "toskr-im-message-watch.jsonl"
	maxBody       = 4 << 20
	maxSeen       = 20_000
)

//go:embed bridge.js
var bridgeTemplate string

type ContextItem struct {
	MessageID    string `json:"messageId"`
	SenderUID    string `json:"senderUid"`
	SenderName   string `json:"senderName,omitempty"`
	OccurredAtMs int64  `json:"occurredAtMs,omitempty"`
	MessageType  string `json:"messageType,omitempty"`
	Text         string `json:"text"`
}

// Message 与 Tauri 版 IncomingMessage 字段一致（camelCase JSON）。
type Message struct {
	BridgeVersion    int             `json:"bridgeVersion"`
	ConversationID   string          `json:"conversationId"`
	MessageID        string          `json:"messageId"`
	ConversationName string          `json:"conversationName,omitempty"`
	SenderUID        string          `json:"senderUid"`
	SenderName       string          `json:"senderName,omitempty"`
	OccurredAtMs     int64           `json:"occurredAtMs,omitempty"`
	CapturedAtMs     int64           `json:"capturedAtMs"`
	MentionedSelf    bool            `json:"mentionedSelf"`
	FollowedSender   bool            `json:"followedSender"`
	MatchedRuleIDs   []string        `json:"matchedRuleIds"`
	IsGroup          *bool           `json:"isGroup,omitempty"`
	MessageType      string          `json:"messageType,omitempty"`
	Text             string          `json:"text"`
	Context          []ContextItem   `json:"context"`
	Raw              json.RawMessage `json:"raw,omitempty"`
}

// Rule 是组合关注规则：群 × 发送者 × 关键词，三组都命中（空组视为通过）。匹配在桥脚本里做。
type Rule struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Enabled     bool     `json:"enabled"`
	GroupTerms  []string `json:"groupTerms"`
	SenderTerms []string `json:"senderTerms"`
	Keywords    []string `json:"keywords"`
}

func validShort(s string, max int) bool {
	if s == "" || utf8.RuneCountInString(s) > max {
		return false
	}
	return !strings.ContainsFunc(s, unicode.IsControl)
}

// Validate 与 Tauri 版 validate_message 同口径。
func Validate(m *Message) error {
	switch {
	case m.BridgeVersion != BridgeVersion:
		return errors.New("桥版本不兼容")
	case !validShort(m.ConversationID, 512) || !validShort(m.MessageID, 512):
		return errors.New("消息标识无效")
	case !m.MentionedSelf && !m.FollowedSender && len(m.MatchedRuleIDs) == 0:
		return errors.New("消息未命中 @我、特别关注或组合规则")
	case m.IsGroup == nil || !*m.IsGroup:
		return errors.New("实验监听只接收群组消息")
	}
	tooBig := utf8.RuneCountInString(m.ConversationName) > 1024 || utf8.RuneCountInString(m.SenderName) > 1024 ||
		utf8.RuneCountInString(m.SenderUID) > 512 || len(m.Text) > maxBody || len(m.MatchedRuleIDs) > 50 || len(m.Context) > 8
	for _, id := range m.MatchedRuleIDs {
		tooBig = tooBig || !validShort(id, 128)
	}
	for _, c := range m.Context {
		tooBig = tooBig || !validShort(c.MessageID, 512) || utf8.RuneCountInString(c.SenderUID) > 512 ||
			utf8.RuneCountInString(c.SenderName) > 1024 || len(c.Text) > maxBody
	}
	if tooBig {
		return errors.New("消息字段过大")
	}
	return nil
}

// Record 是账本中的一行（明文 JSON，落盘前加密）。
type Record struct {
	ReceivedAtMs int64   `json:"receivedAtMs"`
	Message      Message `json:"message"`
}

// Status 供设置页展示。
type Status struct {
	Enabled          bool
	Endpoint         string
	StartedAtMs      int64
	Accepted, Dupes  int
	LastAcceptedAtMs int64
	Transport        string
	CDPConnected     bool
	LastError        string
}

// Bridge 是运行中的回环接收端。零值不可用，用 New。
type Bridge struct {
	dir   string
	seal  func([]byte) ([]byte, error)
	open  func([]byte) ([]byte, error)
	OnMsg func(Message)

	mu       sync.Mutex
	st       Status
	srv      *http.Server
	seen     map[string]bool
	seenList []string
	ledgerMu sync.Mutex
}

func New(dir string, seal, open func([]byte) ([]byte, error)) *Bridge {
	return &Bridge{dir: dir, seal: seal, open: open, seen: map[string]bool{}}
}

func (b *Bridge) Status() Status { b.mu.Lock(); defer b.mu.Unlock(); return b.st }

func (b *Bridge) setErr(err error) {
	b.mu.Lock()
	if err != nil {
		b.st.LastError = err.Error()
	} else {
		b.st.LastError = ""
	}
	b.mu.Unlock()
}

// Start 监听 127.0.0.1 随机端口，返回桥地址（含令牌）。重复调用返回现有地址。
func (b *Bridge) Start() (string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.srv != nil {
		return b.st.Endpoint, nil
	}
	tok := make([]byte, 24)
	if _, err := rand.Read(tok); err != nil {
		return "", err
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	path := "/v1/im/" + hex.EncodeToString(tok)
	mux := http.NewServeMux()
	mux.HandleFunc(path, b.handle)
	b.srv = &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second, MaxHeaderBytes: 16 << 10}
	go b.srv.Serve(ln)
	b.st = Status{Enabled: true, Endpoint: "http://" + ln.Addr().String() + path, StartedAtMs: time.Now().UnixMilli(), Transport: "http"}
	return b.st.Endpoint, nil
}

func (b *Bridge) Stop() {
	b.mu.Lock()
	srv := b.srv
	b.srv = nil
	b.st.Enabled, b.st.Endpoint, b.st.CDPConnected = false, "", false
	b.mu.Unlock()
	if srv != nil {
		_ = srv.Close()
	}
}

func cors(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	h.Set("Access-Control-Allow-Headers", "Content-Type")
	h.Set("Access-Control-Allow-Private-Network", "true")
	h.Set("Cache-Control", "no-store")
	h.Set("Content-Type", "application/json; charset=utf-8")
}

func (b *Bridge) handle(w http.ResponseWriter, r *http.Request) {
	cors(w)
	switch r.Method {
	case http.MethodOptions:
		w.WriteHeader(http.StatusNoContent)
	case http.MethodGet:
		_, _ = w.Write([]byte(`{"ok":true,"version":1}`))
	case http.MethodPost:
		raw, err := io.ReadAll(io.LimitReader(r.Body, maxBody*2+1))
		if err != nil || len(raw) > maxBody*2 {
			http.Error(w, `{"ok":false,"error":"请求过大"}`, http.StatusRequestEntityTooLarge)
			return
		}
		var m Message
		if err := json.Unmarshal(raw, &m); err != nil {
			http.Error(w, `{"ok":false,"error":"JSON 无效"}`, http.StatusBadRequest)
			return
		}
		dup, err := b.Accept(m)
		if err != nil {
			w.WriteHeader(http.StatusUnprocessableEntity)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": err.Error()})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "duplicate": dup})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

// Accept 校验 → 去重 → 加密追加账本 → 回调。HTTP 与 CDP 两条传输共用。
func (b *Bridge) Accept(m Message) (duplicate bool, err error) {
	if err := Validate(&m); err != nil {
		return false, err
	}
	key := m.ConversationID + "\x00" + m.MessageID
	b.mu.Lock()
	if b.seen[key] {
		b.st.Dupes++
		b.mu.Unlock()
		return true, nil
	}
	b.seen[key] = true
	b.seenList = append(b.seenList, key)
	if len(b.seenList) > maxSeen {
		delete(b.seen, b.seenList[0])
		b.seenList = b.seenList[1:]
	}
	b.mu.Unlock()
	now := time.Now().UnixMilli()
	if err := b.appendLedger(Record{ReceivedAtMs: now, Message: m}); err != nil {
		b.setErr(err)
		return false, err
	}
	b.mu.Lock()
	b.st.Accepted++
	b.st.LastAcceptedAtMs = now
	b.mu.Unlock()
	if b.OnMsg != nil {
		b.OnMsg(m)
	}
	return false, nil
}

func (b *Bridge) ledgerPath() string { return filepath.Join(b.dir, LedgerFile) }

func (b *Bridge) appendLedger(r Record) error {
	plain, err := json.Marshal(r)
	if err != nil {
		return err
	}
	sealed, err := b.seal(plain)
	if err != nil {
		return err
	}
	b.ledgerMu.Lock()
	defer b.ledgerMu.Unlock()
	f, err := os.OpenFile(b.ledgerPath(), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.WriteString(base64.StdEncoding.EncodeToString(sealed) + "\n"); err != nil {
		return err
	}
	return f.Sync()
}

// Recent 读账本最后 limit 条（坏行跳过；明文旧行兼容）。
func (b *Bridge) Recent(limit int) ([]Record, error) {
	f, err := os.Open(b.ledgerPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []Record
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), maxBody*3)
	for sc.Scan() {
		line := sc.Bytes()
		plain := line
		if len(line) > 0 && line[0] != '{' {
			raw, err := base64.StdEncoding.DecodeString(string(line))
			if err != nil {
				continue
			}
			if plain, err = b.open(raw); err != nil {
				continue
			}
		}
		var r Record
		if json.Unmarshal(plain, &r) != nil || Validate(&r.Message) != nil {
			continue
		}
		out = append(out, r)
		if len(out) > limit {
			out = out[1:]
		}
	}
	return out, sc.Err()
}

// Script 生成桥脚本：transport 为 http（手动粘贴到 IM 的 DevTools Console）或 cdp（自动注入）。
func Script(endpoint, transport string, startedAtMs int64, rules []Rule) string {
	if rules == nil {
		rules = []Rule{}
	}
	rj, _ := json.Marshal(rules)
	return strings.NewReplacer(
		`"__TOSKR_ENDPOINT__"`, strconv.Quote(endpoint),
		`"__TOSKR_TRANSPORT__"`, strconv.Quote(transport),
		"__TOSKR_STARTED_AT__", strconv.FormatInt(startedAtMs, 10),
		"__TOSKR_RULES__", string(rj),
	).Replace(bridgeTemplate)
}

// FormatNote 与 Tauri 版 formatMessageWatchNote 同格式：笔记只承载可读摘要。
func FormatNote(m Message, receivedAt time.Time) string {
	clean := func(s, fallback string) string {
		s = strings.TrimSpace(strings.NewReplacer("\r", " ", "\n", " ", "\t", " ").Replace(s))
		if s == "" {
			return fallback
		}
		return s
	}
	group := clean(m.ConversationName, "未知群组")
	fb := "未知发送者"
	if m.SenderUID != "" {
		fb = "用户 " + m.SenderUID
	}
	sender := clean(m.SenderName, fb)
	var reasons []string
	if m.MentionedSelf {
		reasons = append(reasons, "@我")
	}
	if m.FollowedSender {
		reasons = append(reasons, "特别关注")
	}
	if len(m.MatchedRuleIDs) > 0 {
		reasons = append(reasons, "组合规则")
	}
	body := strings.TrimSpace(m.Text)
	if body == "" {
		body = "[" + clean(m.MessageType, "非文本消息") + "]"
	}
	at := receivedAt
	if m.OccurredAtMs > 0 {
		at = time.UnixMilli(m.OccurredAtMs)
	}
	return fmt.Sprintf("【%s】\n%s · %s · %s\n%s\n\n消息标识：%s", group, sender, strings.Join(reasons, " + "), at.Format("2006/1/2 15:04:05"), body, m.MessageID)
}
