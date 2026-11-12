package main

import "testing"

// 让位计算（同 dnd-kit verticalListSortingStrategy）：往上拖，落点与被拿起项之间的项下移一个身位，拿起项占位移到落点。
func TestSortDragOffsets(t *testing.T) {
	ids := []string{"a", "b", "c", "d"}
	s := sortDrag{h: map[string]float32{"a": 100, "b": 50, "c": 30, "d": 40}}
	s.begin("c")
	s.track("a", 100, 10, true) // 指针落在 a 的布局框里
	want := map[string]float32{"a": 38, "b": 38, "c": -(100 + 8 + 50 + 8), "d": 0}
	for id, w := range want {
		if got := s.offset(ids, id, 8); got != w {
			t.Fatalf("上拖 %s 平移 %v，应为 %v", id, got, w)
		}
	}
	s.track("d", 40, 5, true) // 改拖到 d：b 不动，d 上移让位，c 占位下移到 d 的位置
	if s.offset(ids, "d", 8) != -38 || s.offset(ids, "c", 8) != 48 || s.offset(ids, "b", 8) != 0 {
		t.Fatalf("下拖 c=%v d=%v", s.offset(ids, "c", 8), s.offset(ids, "d", 8))
	}
	s.track("b", 50, 60, true) // 指针在 b 的框外（落在间隙）：落点不变
	if s.over != "d" {
		t.Fatalf("间隙里不改落点 %q", s.over)
	}
	if from, to := s.end(); from != "c" || to != "d" || s.active != "" {
		t.Fatalf("end %q→%q", from, to)
	}
}
