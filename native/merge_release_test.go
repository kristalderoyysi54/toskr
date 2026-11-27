package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 「并入正式版」：正式版在运行 / 没数据 / 取消确认都不写；确认后补过去并回报；再点一次没有可并的。
func TestMergeToRelease(t *testing.T) {
	a, _ := testApp(t, "迭代期的一条")
	k2 := bytes.Repeat([]byte{2}, 32)
	dst := filepath.Join(t.TempDir(), "v1")
	oT, oK, oRun, oAsk, oGo := handoffTarget, tauriKey, releaseRunning, mergeAsk, pfGo
	t.Cleanup(func() { handoffTarget, tauriKey, releaseRunning, mergeAsk, pfGo = oT, oK, oRun, oAsk, oGo })
	pfGo = func(f func()) { f() }
	handoffTarget = func() (string, error) { return dst, nil }
	tauriKey = func() ([]byte, error) { return bytes.Clone(k2), nil }
	running, answer := true, false
	var asked *store.MergeReport
	releaseRunning = func() bool { return running }
	mergeAsk = func(r store.MergeReport) bool { asked = &r; return answer }
	count := func() int {
		s, err := store.OpenDir(dst, k2)
		if err != nil {
			t.Fatal(err)
		}
		return len(s.Notes())
	}

	a.mergeToRelease()
	if a.hudText != "先退出正式版 Toskr，再并入" || a.merging {
		t.Fatalf("正式版在运行应拒绝 %q", a.hudText)
	}
	running = false
	a.mergeToRelease()
	if a.hudText != "正式版还没有数据：先打开一次正式版 Toskr" || a.merging {
		t.Fatalf("%q", a.hudText)
	}
	rel, _ := store.OpenDir(dst, k2)
	rel.Add(store.Note{Section: store.SectionInbox, Text: "正式版原有"})
	_ = rel.Flush()

	a.mergeToRelease()
	if asked == nil || asked.Notes != 1 || count() != 1 || a.merging {
		t.Fatalf("取消确认不应写入 %+v", asked)
	}
	answer = true
	a.mergeToRelease()
	if count() != 2 || a.hudText != "已并入正式版：新增 1 条、更新 0 条" || a.merging {
		t.Fatalf("应并入 1 条 %q 共 %d", a.hudText, count())
	}
	a.mergeToRelease()
	if a.hudText != "正式版已是最新，没有要并入的内容" || count() != 2 {
		t.Fatalf("%q", a.hudText)
	}
	if s := mergeSpec(*asked).String(); !bytes.Contains([]byte(s), []byte("新增 1 · 更新 0")) {
		t.Fatalf("确认窗 %q", s)
	}
}

// TestMergeConfirmShots：并入确认窗浅深两色截图（TOSKR_SHOT_DIR 未设时跳过）。
func TestMergeConfirmShots(t *testing.T) {
	dir := os.Getenv("TOSKR_SHOT_DIR")
	if dir == "" {
		t.Skip("set TOSKR_SHOT_DIR")
	}
	testApp(t)
	home, _ := os.UserHomeDir()
	spec := mergeSpec(store.MergeReport{Notes: 41, Clips: 6, ClipSkip: 1289, Updated: 12, Tasks: 3, Bills: 1, Sections: 2, Target: filepath.Join(home, "Documents", "Toskr", "v1")})
	for _, dark := range []bool{false, true} {
		cw := &confirmWin{spec: spec, answer: func(bool) {}}
		tt := ui.NewTester(func(c *ui.Context) { confirmView(c, cw) }, confirmW, 300)
		tt.SetDark(dark)
		tt.Frame()
		tt.Frame()
		save(t, filepath.Join(dir, "merge-confirm-"+map[bool]string{false: "light", true: "dark"}[dark]+".png"), tt.Image())
	}
}
