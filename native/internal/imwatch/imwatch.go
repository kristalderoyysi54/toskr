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
	"slices"
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
	MessageID    string  `json:"messageId"`
	SenderUID    string  `json:"senderUid"`
	SenderName   string  `json:"senderName,omitempty"`
	OccurredAtMs int64   `json:"occurredAtMs,omitempty"`
	MessageType  string  `json:"messageType,omitempty"`
	Text         string  `json:"text"`
	Images       []Image `json:"images,omitempty"`
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
	// Images：桥在 IM 页面里用其登录态取回的图片（data URL）；Accept 存进媒体库后只留 File，账本不存图片本体。
	Images []Image `json:"images,omitempty"`
	// ImageProbe：正文像「[图片]」却没认出图片时，桥回传的字段形状（键路径 + 值类型 / 域名），只写诊断不入账本。
	ImageProbe []string `json:"imageProbe,omitempty"`
}

// Image 是消息里的一张图。
type Image struct {
	Data string `json:"data,omitempty"` // data:image/...;base64,...
	File string `json:"file,omitempty"` // 媒体库文件名
}

const maxImages = 9

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
		utf8.RuneCountInString(m.SenderUID) > 512 || len(m.Text) > maxBody || len(m.MatchedRuleIDs) > 50 || len(m.Context) > 8 ||
		len(m.Images) > maxImages || len(m.ImageProbe) > 80
	for _, id := range m.MatchedRuleIDs {
		tooBig = tooBig || !validShort(id, 128)
	}
	for _, c := range m.Context {
		tooBig = tooBig || !validShort(c.MessageID, 512) || utf8.RuneCountInString(c.SenderUID) > 512 ||
			utf8.RuneCountInString(c.SenderName) > 1024 || len(c.Text) > maxBody || len(c.Images) > maxImages
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
	LastSeenAtMs     int64 // 手动桥最近一次心跳 / 投递（桥脚本每 2 秒 GET 一次）
}

// Connected：自动接入看 CDP 连接；手动桥看 6 秒内是否有心跳。
func (s Status) Connected(nowMs int64) bool {
	if s.CDPConnected {
		return true
	}
	return s.Enabled && s.LastSeenAtMs > 0 && nowMs-s.LastSeenAtMs < 6000
}

// LedgerPath 是原始消息账本路径。
func (b *Bridge) LedgerPath() string { return b.ledgerPath() }

// Bridge 是运行中的回环接收端。零值不可用，用 New。
type Bridge struct {
	dir   string
	seal  func([]byte) ([]byte, error)
	open  func([]byte) ([]byte, error)
	OnMsg func(Message)
	// SaveImage 把一张图存进媒体库并返回文件名（nil = 不收图片）；OnProbe 收到「没认出图片」的字段形状（写诊断）。
	SaveImage func(raw []byte) (string, error)
	OnProbe   func(m Message)

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
	if r.Method == http.MethodGet || r.Method == http.MethodPost {
		b.mu.Lock()
		b.st.LastSeenAtMs = time.Now().UnixMilli()
		b.mu.Unlock()
	}
	switch r.Method {
	case http.MethodOptions:
		w.WriteHeader(http.StatusNoContent)
	case http.MethodGet:
		_, _ = w.Write([]byte(`{"ok":true,"version":1}`))
	case http.MethodPost:
		raw, err := io.ReadAll(io.LimitReader(r.Body, maxBody*16+1)) // 带图片（data URL）时体积大
		if err != nil || len(raw) > maxBody*16 {
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
	b.localizeImages(&m)
	if len(m.ImageProbe) > 0 && b.OnProbe != nil {
		b.OnProbe(m)
	}
	m.ImageProbe = nil
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

// localizeImages：data URL 解码后交给 SaveImage，只保留文件名；解不开 / 存不下的图丢掉。
func (b *Bridge) localizeImages(m *Message) {
	m.Images = b.saveImages(m.Images)
	for i := range m.Context {
		m.Context[i].Images = b.saveImages(m.Context[i].Images)
	}
}

func (b *Bridge) saveImages(in []Image) []Image {
	var out []Image
	for _, im := range in {
		if im.Data == "" || b.SaveImage == nil {
			continue
		}
		_, enc, ok := strings.Cut(im.Data, ";base64,")
		if !ok || !strings.HasPrefix(im.Data, "data:image/") {
			continue
		}
		raw, err := base64.StdEncoding.DecodeString(enc)
		if err != nil || len(raw) == 0 {
			continue
		}
		if name, err := b.SaveImage(raw); err == nil && name != "" && !slices.ContainsFunc(out, func(x Image) bool { return x.File == name }) {
			out = append(out, Image{File: name})
		}
	}
	return out
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
	sc.Buffer(make([]byte, 64<<10), maxBody*4)
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
