package store

import (
	"bytes"
	"testing"
	"time"
)

func TestDeliveriesLinkUnlinkAndPersist(t *testing.T) {
	dir := t.TempDir()
	key := bytes.Repeat([]byte{7}, 32)
	s, err := OpenDir(dir, key)
	if err != nil {
		t.Fatal(err)
	}
	src, _, _ := s.Add(Note{Section: SectionInbox, Text: "问题"})
	sent := time.Now().Add(-10 * time.Minute)
	d := s.AddDelivery(Delivery{At: sent, TargetName: "ChatGPT", TargetBundle: "com.openai.chat", Status: "sent", SourceIDs: []string{src.ID}})
	s.AddDelivery(Delivery{At: sent, TargetBundle: "com.openai.chat", Status: "failed"})

	reply, _, _ := s.Add(Note{Section: SectionInbox, Text: "回答", BundleID: "com.openai.chat", CreatedAt: sent.Add(5 * time.Minute)})
	late := Note{Text: "太晚", BundleID: "com.openai.chat", CreatedAt: sent.Add(ResultWindow + time.Minute)}
	other := Note{Text: "别处", BundleID: "com.apple.Safari", CreatedAt: sent.Add(time.Minute)}
	if got := DeliveryCandidates(reply, s.Deliveries()); len(got) != 1 || got[0].ID != d.ID {
		t.Fatalf("只有成功、同应用、30 分钟内的发送是候选 %+v", got)
	}
	if len(DeliveryCandidates(late, s.Deliveries())) != 0 || len(DeliveryCandidates(other, s.Deliveries())) != 0 {
		t.Fatal("超窗或别的应用不应是候选")
	}
	if got := ResultCandidates(d, []Note{late, reply, other}); len(got) != 1 || got[0].Text != "回答" {
		t.Fatalf("回复候选 %+v", got)
	}

	if prev, ok := s.LinkResult(d.ID, reply.ID); !ok || prev != "" {
		t.Fatalf("关联 ok=%v prev=%q", ok, prev)
	}
	if err := s.Flush(); err != nil {
		t.Fatal(err)
	}
	s2, err := OpenDir(dir, key)
	if err != nil {
		t.Fatal(err)
	}
	n, _ := s2.Note(reply.ID)
	ds := s2.Deliveries()
	if len(ds) != 2 || ds[1].ResultNoteID != reply.ID || n.Provenance == nil || n.Provenance.DeliveryID != d.ID || n.Provenance.SourceIDs[0] != src.ID {
		t.Fatalf("发送记录与溯源应落盘 %+v %+v", ds, n.Provenance)
	}

	// 清除记录后笔记仍带溯源；按笔记取消关联也能清掉
	prev := s2.Deliveries()
	s2.ClearDeliveries()
	if len(s2.Deliveries()) != 0 {
		t.Fatal("清除记录")
	}
	if id := s2.UnlinkNote(reply.ID); id != d.ID {
		t.Fatalf("UnlinkNote 应返回原发送 %q", id)
	}
	if n, _ := s2.Note(reply.ID); n.Provenance != nil {
		t.Fatal("溯源应清掉")
	}
	s2.RestoreDeliveries(prev)
	if len(s2.Deliveries()) != 2 {
		t.Fatal("撤销清除")
	}
}
