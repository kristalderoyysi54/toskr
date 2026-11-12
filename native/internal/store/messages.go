package store

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

// 「内容 → 消息」（同 Tauri lib/messages.ts 与 notesStore 的 messages 投影）：IM 只读桥送来的
// @我 / 特别关注 / 组合规则命中的群消息。原始消息在加密 JSONL 账本里，这里是带工作流状态的投影。

// MessageContext 是捕获时客户端内存里已有的前文。
type MessageContext struct {
	MessageID    string   `json:"messageId"`
	SenderUID    string   `json:"senderUid"`
	SenderName   string   `json:"senderName,omitempty"`
	OccurredAtMs int64    `json:"occurredAtMs,omitempty"`
	MessageType  string   `json:"messageType,omitempty"`
	Text         string   `json:"text"`
	Images       []string `json:"images,omitempty"` // 前文里的图片（媒体库文件名）
}

// Message 与 Tauri MessageItem 同字段（camelCase JSON，可直接读 Tauri 的 messages 数组）。
type Message struct {
	ID               string           `json:"id"`
	Source           string           `json:"source"`
	SourceApp        string           `json:"sourceApp,omitempty"`
	SourceBundle     string           `json:"sourceBundle,omitempty"`
	ConversationID   string           `json:"conversationId"`
	MessageID        string           `json:"messageId"`
	ConversationName string           `json:"conversationName,omitempty"`
	SenderUID        string           `json:"senderUid"`
	SenderName       string           `json:"senderName,omitempty"`
	OccurredAtMs     int64            `json:"occurredAtMs,omitempty"`
	ReceivedAtMs     int64            `json:"receivedAtMs"`
	MentionedSelf    bool             `json:"mentionedSelf"`
	FollowedSender   bool             `json:"followedSender"`
	MatchedRuleIDs   []string         `json:"matchedRuleIds"`
	MessageType      string           `json:"messageType,omitempty"`
	Text             string           `json:"text"`
	Images           []string         `json:"images,omitempty"` // 消息里的图片（已存进媒体库的文件名，按出现顺序）
	Context          []MessageContext `json:"context"`
	Status           string           `json:"status"` // new | waiting | done | archived
	LinkedTaskID     string           `json:"linkedTaskId,omitempty"`
	AIDraft          string           `json:"aiDraft,omitempty"`
	AIDraftAtMs      int64            `json:"aiDraftAtMs,omitempty"`
}

// MessageRule 是组合关注规则（同 Tauri MessageWatchRule）：同一维度内 OR，不同非空维度间 AND。
type MessageRule struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Enabled     bool     `json:"enabled"`
	GroupTerms  []string `json:"groupTerms"`
	SenderTerms []string `json:"senderTerms"`
	Keywords    []string `json:"keywords"`
}

// IMProfile 是用户「探测并确认」的监听目标（Tauri 存 localStorage，不随数据导入）。
type IMProfile struct {
	AppName  string `json:"appName"`
	BundleID string `json:"bundleId"`
	BinPath  string `json:"binPath"`
}

const (
	messageSource = "im"
	contextMax    = 8
	goneMax       = 5000
)

// MessageKey 同 Tauri messageSourceKey：JSON.stringify([source, conversationId, messageId])。
func MessageKey(conversationID, messageID string) string {
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false) // 与 JSON.stringify 同：< > & 不转义
	_ = enc.Encode([]string{messageSource, conversationID, messageID})
	return strings.TrimSuffix(b.String(), "\n")
}

func (m Message) At() int64 {
	if m.OccurredAtMs > 0 {
		return m.OccurredAtMs
	}
	return m.ReceivedAtMs
}

// Done：已处理（含旧数据的 archived）。
func (m Message) Done() bool { return m.Status == "done" || m.Status == "archived" }

func normalizeContext(in []MessageContext) []MessageContext {
	if len(in) > contextMax {
		in = in[len(in)-contextMax:]
	}
	seen := map[string]bool{}
	out := []MessageContext{}
	for _, c := range in {
		if c.MessageID == "" || seen[c.MessageID] {
			continue
		}
		seen[c.MessageID] = true
		c.Text = strings.ReplaceAll(c.Text, "\x00", "")
		out = append(out, c)
	}
	return out
}

// mergeMessage 同 Tauri mergeMessageCapture：工作流字段（状态 / 关联任务 / 草稿）属于 Toskr，重放账本不覆盖；
// 其余字段采用更丰富的那份。
func mergeMessage(cur *Message, in Message) Message {
	in.ID = MessageKey(in.ConversationID, in.MessageID)
	in.Source = messageSource
	in.Text = strings.ReplaceAll(in.Text, "\x00", "")
	in.Context = normalizeContext(in.Context)
	in.MatchedRuleIDs = uniq(in.MatchedRuleIDs)
	if in.Status == "" {
		in.Status = "new"
	}
	if cur == nil {
		return in
	}
	in.Status, in.LinkedTaskID, in.AIDraft, in.AIDraftAtMs = cur.Status, cur.LinkedTaskID, cur.AIDraft, cur.AIDraftAtMs
	in.ConversationName = cmp(in.ConversationName, cur.ConversationName)
	in.SenderName = cmp(in.SenderName, cur.SenderName)
	in.SourceApp = cmp(in.SourceApp, cur.SourceApp)
	in.SourceBundle = cmp(in.SourceBundle, cur.SourceBundle)
	if in.OccurredAtMs == 0 {
		in.OccurredAtMs = cur.OccurredAtMs
	}
	in.Text = cmp(in.Text, cur.Text)
	if len(in.Images) == 0 {
		in.Images = cur.Images
	}
	if len(in.Context) < len(cur.Context) {
		in.Context = cur.Context
	}
	in.MatchedRuleIDs = uniq(append(slices.Clone(cur.MatchedRuleIDs), in.MatchedRuleIDs...))
	return in
}

func cmp(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func uniq(xs []string) []string {
	out := []string{}
	for _, x := range xs {
		if !slices.Contains(out, x) {
			out = append(out, x)
		}
	}
	return out
}

func sortMessages(ms []Message) {
	slices.SortStableFunc(ms, func(a, b Message) int { return int(b.At() - a.At()) })
}

func (s *Store) Messages() []Message {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.messages)
}

// IngestMessages 合并捕获（同 Tauri ingestMessageCaptures，按发生时刻新→旧排）。
// replay=true 是启动时重放账本：用户删掉的消息不再复活（Tauri 无此记录，删了重启会回来）。
func (s *Store) IngestMessages(in []Message, replay bool) (added, updated int) {
	if len(in) == 0 {
		return 0, 0
	}
	_ = s.mutate(func() bool {
		idx := map[string]int{}
		for i, m := range s.messages {
			idx[m.ID] = i
		}
		for _, m := range in {
			id := MessageKey(m.ConversationID, m.MessageID)
			if replay && slices.Contains(s.messagesGone, id) {
				continue
			}
			if i, ok := idx[id]; ok {
				s.messages[i] = mergeMessage(&s.messages[i], m)
				updated++
				continue
			}
			idx[id] = len(s.messages)
			s.messages = append(s.messages, mergeMessage(nil, m))
			added++
		}
		sortMessages(s.messages)
		return added+updated > 0
	})
	return added, updated
}

// SetMessagesStatus 批量改状态（同 Tauri setMessagesStatus）。
func (s *Store) SetMessagesStatus(ids []string, status string) {
	_ = s.mutate(func() bool {
		changed := false
		for i := range s.messages {
			if slices.Contains(ids, s.messages[i].ID) && s.messages[i].Status != status {
				s.messages[i].Status, changed = status, true
			}
		}
		return changed
	})
}

// SaveMessageDraft 存 / 清 AI 回复草稿。
func (s *Store) SaveMessageDraft(id, draft string) {
	draft = strings.TrimSpace(draft)
	_ = s.mutate(func() bool {
		i := slices.IndexFunc(s.messages, func(m Message) bool { return m.ID == id })
		if i < 0 {
			return false
		}
		s.messages[i].AIDraft, s.messages[i].AIDraftAtMs = draft, 0
		if draft != "" {
			s.messages[i].AIDraftAtMs = time.Now().UnixMilli()
		}
		return true
	})
}

// RemoveMessages 删除并返回被删的快照（撤销用）；记下标识，重放账本时不再收回。
func (s *Store) RemoveMessages(ids []string) []Message {
	var removed []Message
	_ = s.mutate(func() bool {
		s.messages = slices.DeleteFunc(s.messages, func(m Message) bool {
			if slices.Contains(ids, m.ID) {
				removed = append(removed, m)
				return true
			}
			return false
		})
		for _, m := range removed {
			if !slices.Contains(s.messagesGone, m.ID) {
				s.messagesGone = append(s.messagesGone, m.ID)
			}
		}
		if n := len(s.messagesGone); n > goneMax {
			s.messagesGone = slices.Clone(s.messagesGone[n-goneMax:])
		}
		return len(removed) > 0
	})
	return removed
}

// RestoreMessages 撤销删除（已存在的跳过）。
func (s *Store) RestoreMessages(items []Message) {
	_ = s.mutate(func() bool {
		changed := false
		for _, m := range items {
			if slices.ContainsFunc(s.messages, func(x Message) bool { return x.ID == m.ID }) {
				continue
			}
			s.messages = append(s.messages, m)
			s.messagesGone = slices.DeleteFunc(s.messagesGone, func(id string) bool { return id == m.ID })
			changed = true
		}
		sortMessages(s.messages)
		return changed
	})
}

// MessageTaskTitle 同 Tauri messageTaskTitle：「[群名] 正文前 80 字」。
func MessageTaskTitle(m Message) string {
	group := strings.TrimSpace(m.ConversationName)
	if group == "" {
		group = "群消息"
	}
	body := strings.Join(strings.Fields(m.Text), " ")
	if body == "" {
		return "[" + group + "] 处理消息"
	}
	if utf8.RuneCountInString(body) > 80 {
		body = string([]rune(body)[:80])
	}
	return "[" + group + "] " + body
}

// MessageTaskNote 同 Tauri messageTaskNote：来源 / 发送者 / 时间 / 消息标识 + 正文。
func MessageTaskNote(m Message) string {
	sender := cmp(cmp(m.SenderName, m.SenderUID), "未知发送者")
	body := m.Text
	if body == "" {
		body = "[" + cmp(m.MessageType, "非文本消息") + "]"
	}
	return strings.Join([]string{
		fmt.Sprintf("来源：%s · %s", cmp(m.SourceApp, "IM"), cmp(m.ConversationName, m.ConversationID)),
		"发送者：" + sender,
		"时间：" + time.UnixMilli(m.At()).Format("2006/1/2 15:04:05"),
		"消息标识：" + m.MessageID,
		"",
		body,
	}, "\n")
}

// MessageToTask 同 Tauri messageToTask：mode = waiting（进行中，消息转「等待回复」）| reminder（带到期）| task。
// 已关联且任务还在时返回 "existing"。
func (s *Store) MessageToTask(id, mode string, dueAt time.Time) (result, taskID string) {
	result = "missing"
	_ = s.mutate(func() bool {
		i := slices.IndexFunc(s.messages, func(m Message) bool { return m.ID == id })
		if i < 0 {
			return false
		}
		m := s.messages[i]
		if m.LinkedTaskID != "" && slices.ContainsFunc(s.tasks, func(t Task) bool { return t.ID == m.LinkedTaskID }) {
			result, taskID = "existing", m.LinkedTaskID
			return false
		}
		t := Task{ID: newID(), Text: MessageTaskTitle(m), Status: "todo", Priority: "none", CreatedAt: time.Now(), Note: MessageTaskNote(m)}
		status := "done"
		if mode == "waiting" {
			t.Status, status = "doing", "waiting"
		}
		if mode == "reminder" {
			t.DueAt = dueAt
		}
		s.tasks = slices.Insert(s.tasks, 0, t)
		s.messages[i].LinkedTaskID, s.messages[i].Status = t.ID, status
		result, taskID = "added", t.ID
		return true
	})
	return result, taskID
}

// NormalizeMessageRules 同 Tauri normalizeMessageWatchRules：去重、截断，三组全空的规则丢弃。
func NormalizeMessageRules(in []MessageRule) []MessageRule {
	clip := func(s string, n int) string {
		s = strings.TrimSpace(strings.NewReplacer("\r", " ", "\n", " ", "\t", " ").Replace(s))
		if utf8.RuneCountInString(s) > n {
			s = string([]rune(s)[:n])
		}
		return s
	}
	terms := func(xs []string) []string {
		out := []string{}
		seen := map[string]bool{}
		for _, x := range xs {
			t := clip(x, 80)
			if k := strings.ToLower(t); t != "" && !seen[k] && len(out) < 20 {
				seen[k] = true
				out = append(out, t)
			}
		}
		return out
	}
	out := []MessageRule{}
	seen := map[string]bool{}
	for i, r := range in {
		if len(out) >= 50 {
			break
		}
		r.ID = clip(r.ID, 128)
		if r.ID == "" {
			r.ID = fmt.Sprintf("message-rule-%d", i+1)
		}
		if seen[r.ID] {
			continue
		}
		seen[r.ID] = true
		r.Name = clip(r.Name, 40)
		if r.Name == "" {
			r.Name = fmt.Sprintf("关注规则 %d", len(out)+1)
		}
		r.GroupTerms, r.SenderTerms, r.Keywords = terms(r.GroupTerms), terms(r.SenderTerms), terms(r.Keywords)
		if len(r.GroupTerms)+len(r.SenderTerms)+len(r.Keywords) > 0 {
			out = append(out, r)
		}
	}
	return out
}

// Dir 是数据目录（IM 账本与数据文件同目录）。
func (s *Store) Dir() string { return s.dir }

// Key 是本机数据密钥（预检其他数据目录时用同一把解）。
func (s *Store) Key() []byte { return s.key }

// IMLedgerCodec：账本逐行加解密（用途 imwatch，同 Tauri Purpose::ImWatch）。
func (s *Store) IMLedgerCodec() (seal, open func([]byte) ([]byte, error)) {
	return func(b []byte) ([]byte, error) { return Seal(s.key, PurposeIMWatch, b) },
		func(b []byte) ([]byte, error) { return Open(s.key, PurposeIMWatch, b) }
}
