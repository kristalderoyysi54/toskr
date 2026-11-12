package store

import (
	"bytes"
	"testing"
)

// 加发送次数字段之前的旧数据（文件里没有 sendCounted 标记）：重开时按发送历史回填，失败的发送不算。
func TestSendCountBackfillLegacy(t *testing.T) {
	dir, key := t.TempDir(), bytes.Repeat([]byte{1}, 32)
	st, err := OpenDir(dir, key)
	if err != nil {
		t.Fatal(err)
	}
	n, _, _ := st.Add(Note{Section: SectionInbox, Text: "旧卡"})
	st.AddDelivery(Delivery{Status: "sent", SourceIDs: []string{n.ID}})
	st.AddDelivery(Delivery{Status: "sent", SourceIDs: []string{n.ID}})
	st.AddDelivery(Delivery{Status: "failed", SourceIDs: []string{n.ID}})
	st.mu.Lock()
	st.sendCounted = false // 模拟旧版本写出的数据
	st.mu.Unlock()
	if err := st.Flush(); err != nil {
		t.Fatal(err)
	}
	re, err := OpenDir(dir, key)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := re.Note(n.ID); got.SendCount != 2 {
		t.Fatalf("应回填 2 次 %d", got.SendCount)
	}
}
