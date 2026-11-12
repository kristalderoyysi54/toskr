package store

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestMessageKeyMatchesJSONStringify(t *testing.T) {
	if got := MessageKey("g<1>", "m&2"); got != `["im","g<1>","m&2"]` {
		t.Fatal(got)
	}
}

func TestIngestMergeKeepsWorkflowAndSorts(t *testing.T) {
	s, _ := OpenDir(t.TempDir(), key)
	a := Message{ConversationID: "g1", MessageID: "1", Text: "旧", OccurredAtMs: 100, MatchedRuleIDs: []string{"r1"}, SenderName: "小王"}
	b := Message{ConversationID: "g1", MessageID: "2", Text: "新", OccurredAtMs: 200, MentionedSelf: true}
	if add, upd := s.IngestMessages([]Message{a, b}, false); add != 2 || upd != 0 {
		t.Fatal(add, upd)
	}
	ms := s.Messages()
	if ms[0].MessageID != "2" || ms[0].Status != "new" || ms[0].ID != MessageKey("g1", "2") {
		t.Fatalf("应按发生时刻新→旧：%+v", ms[0])
	}
	s.SetMessagesStatus([]string{ms[1].ID}, "waiting")
	s.SaveMessageDraft(ms[1].ID, "  好的  ")
	// 重放同一条：更丰富字段采用新值，状态 / 草稿保留，规则并集
	again := a
	again.SenderName, again.Text, again.MatchedRuleIDs = "", "", []string{"r2"}
	again.Context = []MessageContext{{MessageID: "0", Text: "前文"}}
	if add, upd := s.IngestMessages([]Message{again}, false); add != 0 || upd != 1 {
		t.Fatal(add, upd)
	}
	got := s.Messages()[1]
	if got.Status != "waiting" || got.AIDraft != "好的" || got.Text != "旧" || got.SenderName != "小王" ||
		strings.Join(got.MatchedRuleIDs, ",") != "r1,r2" || len(got.Context) != 1 {
		t.Fatalf("%+v", got)
	}
}

func TestRemovedMessagesStayGoneOnReplay(t *testing.T) {
	s, _ := OpenDir(t.TempDir(), key)
	m := Message{ConversationID: "g", MessageID: "1", Text: "x", MentionedSelf: true}
	s.IngestMessages([]Message{m}, false)
	removed := s.RemoveMessages([]string{MessageKey("g", "1")})
	if len(removed) != 1 || len(s.Messages()) != 0 {
		t.Fatal("删除失败")
	}
	if add, _ := s.IngestMessages([]Message{m}, true); add != 0 {
		t.Fatal("重放账本不应收回删掉的消息")
	}
	s.RestoreMessages(removed)
	if len(s.Messages()) != 1 {
		t.Fatal("撤销应恢复")
	}
	s.RemoveMessages([]string{removed[0].ID})
	if add, _ := s.IngestMessages([]Message{m}, false); add != 1 {
		t.Fatal("实时捕获（同一条再次送来）照常收下")
	}
}

func TestMessageToTask(t *testing.T) {
	s, _ := OpenDir(t.TempDir(), key)
	s.IngestMessages([]Message{{ConversationID: "g", ConversationName: "项目群", MessageID: "1", SenderName: "小王",
		Text: "明天\n发布", OccurredAtMs: time.Date(2026, 11, 6, 9, 30, 0, 0, time.Local).UnixMilli(), MentionedSelf: true}}, false)
	id := MessageKey("g", "1")
	res, tid := s.MessageToTask(id, "waiting", time.Time{})
	if res != "added" || tid == "" {
		t.Fatal(res)
	}
	task := s.Tasks()[0]
	if task.Status != "doing" || task.Text != "[项目群] 明天 发布" || !strings.Contains(task.Note, "发送者：小王") ||
		!strings.Contains(task.Note, "来源：IM · 项目群") || !strings.Contains(task.Note, "2026/11/6 09:30:00") {
		t.Fatalf("%+v", task)
	}
	if m := s.Messages()[0]; m.Status != "waiting" || m.LinkedTaskID != tid {
		t.Fatalf("%+v", m)
	}
	if res, _ := s.MessageToTask(id, "task", time.Time{}); res != "existing" {
		t.Fatal(res)
	}
	_, _, _ = s.DeleteTask(tid)
	due := time.Now().Add(time.Hour)
	if res, _ := s.MessageToTask(id, "reminder", due); res != "added" || !s.Tasks()[0].DueAt.Equal(due) || s.Messages()[0].Status != "done" {
		t.Fatal("任务删了可再转；提醒带到期、消息转已处理")
	}
}

func TestNormalizeMessageRules(t *testing.T) {
	got := NormalizeMessageRules([]MessageRule{
		{ID: "a", Enabled: true, GroupTerms: []string{" 项目群 ", "项目群", ""}},
		{ID: "a", Keywords: []string{"x"}},
		{ID: "b"},
	})
	if len(got) != 1 || got[0].Name != "关注规则 1" || len(got[0].GroupTerms) != 1 || got[0].GroupTerms[0] != "项目群" {
		t.Fatalf("%+v", got)
	}
}

func TestTauriMessagesImport(t *testing.T) {
	doc := `{"state":{"notes":[{"id":"n","text":"x","sectionId":"inbox"}],"settings":{"messagesEnabled":true,
		"messageWatchRules":[{"id":"r","name":"发布","enabled":true,"groupTerms":[],"senderTerms":["小王"],"keywords":[]}]},
		"messages":[{"id":"[\"im\",\"g\",\"1\"]","source":"im","conversationId":"g","messageId":"1","conversationName":null,
		"senderUid":"u","senderName":null,"occurredAtMs":null,"receivedAtMs":5,"mentionedSelf":true,"followedSender":false,
		"matchedRuleIds":[],"isGroup":true,"messageType":null,"text":"hi","context":[],"status":"waiting","linkedTaskId":"t1","aiDraft":"嗯"}]}}`
	st, err := parseTauriDoc([]byte(doc))
	if err != nil {
		t.Fatal(err)
	}
	var cur []Message
	if n := importTauriMessages(&cur, st.Messages); n != 1 || cur[0].Status != "waiting" || cur[0].LinkedTaskID != "t1" || cur[0].AIDraft != "嗯" {
		t.Fatalf("%d %+v", n, cur)
	}
	set := applyTauriSettings(DefaultSettings(), st.Settings)
	if !set.MessagesEnabled || len(set.MessageRules) != 1 || set.MessageRules[0].SenderTerms[0] != "小王" {
		t.Fatalf("%+v", set.MessageRules)
	}
	b, _ := json.Marshal(cur[0])
	if !strings.Contains(string(b), `"status":"waiting"`) {
		t.Fatal(string(b))
	}
}
