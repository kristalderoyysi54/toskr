package store

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func encImg(t *testing.T, jpg bool, c color.RGBA) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 8, 6))
	for i := 0; i < len(img.Pix); i += 4 {
		img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = c.R, c.G, c.B, 255
	}
	var buf bytes.Buffer
	if jpg {
		_ = jpeg.Encode(&buf, img, nil)
	} else {
		_ = png.Encode(&buf, img)
	}
	return buf.Bytes()
}

// 用合成的 Tauri 数据目录（自造密钥加密）验证：分组 / 笔记 / 图片 / 秘文 / 任务 / 账单 / 设置映射，合成数据清理，恢复点。
func TestImportTauri(t *testing.T) {
	tkey := bytes.Repeat([]byte{7}, 32)
	tdir := t.TempDir()
	_ = os.MkdirAll(filepath.Join(tdir, "media"), 0o700)
	seal := func(p Purpose, b []byte) []byte {
		out, err := Seal(tkey, p, b)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	_ = os.WriteFile(filepath.Join(tdir, "media", "img-a.png"), seal(PurposeMedia, encImg(t, false, color.RGBA{255, 0, 0, 255})), 0o600)
	_ = os.WriteFile(filepath.Join(tdir, "media", "img-b.jpg"), seal(PurposeMedia, encImg(t, true, color.RGBA{0, 0, 255, 255})), 0o600)
	state := map[string]any{
		"sections": []any{
			map[string]any{"id": "inbox", "name": "收件箱"},
			map[string]any{"id": "s1", "name": "提示词库", "color": "#3b82f6", "keepAfterSend": true},
			map[string]any{"id": "clipboard", "name": "剪贴板"},
			map[string]any{"id": "secret", "name": "秘文"},
		},
		"notes": []any{
			map[string]any{"id": "n1", "text": "写周报的提示词", "sectionId": "s1", "done": false, "createdAt": 1790000000000, "title": "周报", "blur": true, "tags": []string{"工作"}, "sourceApp": "Safari"},
			map[string]any{"id": "n2", "kind": "image", "text": "图片", "imageFile": "img-a.png", "attachments": []string{"img-b.jpg", "img-gone.png"}, "imageW": 8, "imageH": 6, "sectionId": "inbox", "createdAt": 1790000001000},
			map[string]any{"id": "n3", "kind": "secret", "text": "密文……", "sectionId": "secret", "createdAt": 1790000002000, "secretMeta": map[string]any{"keyId": "k1", "keyLabel": "小明", "direction": "out"}},
			map[string]any{"id": "n4", "text": "剪贴的", "sectionId": "clipboard", "keep": true, "createdAt": 1790000003000},
		},
		"tasks": []any{
			map[string]any{"id": "t1", "text": "交房租", "status": "doing", "priority": "high", "dueAt": 1790100000000, "createdAt": 1790000000000, "remindedAt": nil, "recurrence": map[string]any{"freq": "monthly"}, "checklist": []any{map[string]any{"id": "c1", "text": "转账", "done": true}}},
			map[string]any{"id": "t2", "text": "灵感", "status": "todo", "priority": "none", "dueAt": nil, "createdAt": 1790000000000, "remindedAt": nil, "kind": "spark"},
		},
		"taskSections": []any{map[string]any{"id": "task-inbox", "name": "收集箱"}, map[string]any{"id": "ts1", "name": "家务"}},
		"bills": []any{map[string]any{"id": "b1", "kind": "subscription", "name": "视频会员", "amount": 25, "cycle": "monthly", "nextDueAt": 1790200000000, "status": "active",
			"reminderOffsets": []int{1}, "remindedFor": map[string]any{"dueAt": 1790200000000, "offsets": []int{1}}, "fallbackColor": "#ef4444", "createdAt": 1789000000000,
			"history": []any{map[string]any{"id": "h", "periodDueAt": 1787600000000, "amount": 25, "paidAt": 1787600000000, "method": "auto"}}}},
		"settings": map[string]any{"colorScheme": "paper", "hotkeyModifier": "control", "hotkeyGapMs": 400, "currencySymbol": "¥", "secretEnabled": true, "subscriptionsEnabled": true,
			"secretKeys":   []any{map[string]any{"id": "k1", "label": "小明", "passphrase": "暗号", "createdAtMs": 1789000000000, "updatedAtMs": 1789000000000}},
			"promptGroups": []any{map[string]any{"id": "general", "name": "通用", "order": 0}, map[string]any{"id": "g2", "name": "写作", "order": 1}},
			"targetProfiles": []any{map[string]any{"id": "default-safe", "name": "稳妥发送", "bundleIds": []string{}, "promptGroupId": "general", "defaultFormat": "plain", "defaultMarkdownMode": "preserve", "enterPolicy": "never", "privacyPolicy": "requireRedaction", "keepPanel": false},
				map[string]any{"id": "p-ai", "name": "AI 对话", "bundleIds": []string{"com.openai.chat"}, "promptGroupId": "g2", "defaultFormat": "plain", "defaultMarkdownMode": "strip", "enterPolicy": "confirm", "privacyPolicy": "confirmRaw", "keepPanel": true}},
			"defaultTargetProfileId": "p-ai",
			"promptSnippets":         []any{map[string]any{"id": "s1", "label": "翻译", "text": "翻译：{内容}", "groupId": "g2", "isCommon": true}}},
	}
	raw, _ := json.Marshal(map[string]any{"state": state, "version": 27})
	_ = os.WriteFile(filepath.Join(tdir, "toskr-data.json"), seal(PurposeData, raw), 0o600)
	// 最近发送：明文 JSONL 事件流；d1 发出并有回复，d2 失败，d3 只开过预检（不导入），坏行跳过
	activity := strings.Join([]string{
		`{"deliveryId":"d1","eventType":"draftCreated","timestampMs":1789000000000,"sourceItemIds":["n1"],"targetBundleId":"com.openai.chat","targetAppName":"ChatGPT","profileId":"p-ai"}`,
		`{"deliveryId":"d1","eventType":"sendSent","timestampMs":1789000001000,"sourceItemIds":["n1"],"targetBundleId":"com.openai.chat","targetAppName":"ChatGPT","profileId":"p-ai","textCharCount":12,"imageCount":0,"redactionCount":2}`,
		`{"deliveryId":"d1","eventType":"resultCaptured","timestampMs":1789000060000,"resultNoteId":"n2","profileId":"p-ai"}`,
		`{"deliveryId":"d2","eventType":"sendFailed","timestampMs":1789000100000,"targetAppName":"Cursor","profileId":"default-safe","reasonCode":"target_exited"}`,
		`{"deliveryId":"d3","eventType":"preflightOpened","timestampMs":1789000200000}`,
		`坏行`,
	}, "\n")
	_ = os.WriteFile(filepath.Join(tdir, "toskr-delivery-activity.jsonl"), []byte(activity), 0o600)

	s, err := OpenDir(t.TempDir(), bytes.Repeat([]byte{1}, 32))
	if err != nil {
		t.Fatal(err)
	}
	_, _, _ = s.Add(Note{Section: SectionInbox, Text: "合成", SourceApp: "Seed"})
	_, _, _ = s.Add(Note{Section: SectionInbox, Text: "本机自己的"})
	_ = s.Flush()

	if _, err := s.ImportTauri(tdir, bytes.Repeat([]byte{9}, 32)); err == nil {
		t.Fatal("错误密钥应报错")
	}
	rep, err := s.ImportTauri(tdir, tkey)
	if err != nil {
		t.Fatal(err)
	}
	if ds := s.Deliveries(); rep.Deliveries != 2 || len(ds) != 2 || ds[0].ID != "d2" || ds[0].Status != "failed" || ds[0].Err != "target_exited" ||
		ds[1].Status != "sent" || ds[1].ResultNoteID != "n2" || ds[1].Redactions != 2 || ds[1].TextChars != 12 || ds[1].Profile != "AI 对话" || ds[1].TargetName != "ChatGPT" {
		t.Fatalf("发送记录 %d %+v", rep.Deliveries, s.Deliveries())
	}
	if rep.Notes != 3 || rep.Secrets != 1 || rep.Tasks != 2 || rep.Bills != 1 || rep.SeedRemoved != 1 || rep.Media != 2 || rep.MediaMissing != 1 || rep.Recovery == "" {
		t.Fatalf("报告 %+v", rep)
	}
	secs := s.Sections()
	if len(secs) != 3 || secs[1].ID != "s1" || secs[1].Color != "#3b82f6" || !secs[1].KeepAfterSend || secs[2].ID != SectionClipboard {
		t.Fatalf("分组 %+v", secs)
	}
	n1, _ := s.Note("n1")
	if n1.Section != "s1" || n1.Title != "周报" || !n1.Blur || n1.Tags[0] != "工作" || n1.CreatedAt.UnixMilli() != 1790000000000 {
		t.Fatalf("n1 %+v", n1)
	}
	n2, _ := s.Note("n2")
	if n2.ImageFile == "" || len(n2.Attachments) != 1 {
		t.Fatalf("n2 %+v", n2)
	}
	for _, f := range n2.MediaFiles() {
		b, err := s.LoadImage(f)
		if err != nil || !bytes.HasPrefix(b, []byte("\x89PNG")) {
			t.Fatalf("媒体 %s %v", f, err)
		}
	}
	if n4, _ := s.Note("n4"); !n4.Kept || n4.Section != SectionClipboard {
		t.Fatalf("n4 %+v", n4)
	}
	if sec := s.Secrets(); len(sec) != 1 || sec[0].KeyID != "k1" || sec[0].Direction != "out" {
		t.Fatalf("秘文 %+v", sec)
	}
	var t1 Task
	for _, x := range s.Tasks() {
		if x.ID == "t1" {
			t1 = x
		}
	}
	if t1.Status != "doing" || t1.Recurrence != "monthly" || t1.DueAt.UnixMilli() != 1790100000000 || len(t1.Checklist) != 1 {
		t.Fatalf("任务 %+v", t1)
	}
	if b := s.Bills(); len(b) != 1 || b[0].Amount != 25 || len(b[0].Reminded) != 1 || len(b[0].History) != 1 || b[0].FallbackColor != "#ef4444" {
		t.Fatalf("账单 %+v", b)
	}
	st := s.Settings()
	if st.ColorScheme != "paper" || st.TriggerModifier != "control" || st.TriggerGapMs != 400 || !st.SecretEnabled || len(st.SecretKeys) != 1 {
		t.Fatalf("设置 %+v", st)
	}
	if g, ps, def := st.ProfileConfig(); len(g) != 2 || len(ps) != 2 || def != "p-ai" || ps[1].OutputMode() != "strip-markdown" || !ps[1].KeepPanel {
		t.Fatalf("发送方案应整组导入 %+v %+v %q", g, ps, def)
	}
	if len(st.PromptSnippets) != 1 || st.PromptSnippets[0].Label != "翻译" || !st.PromptSnippets[0].IsCommon {
		t.Fatalf("模板应导入 %+v", st.PromptSnippets)
	}
	if _, ok := s.Note(func() string {
		for _, n := range s.Notes() {
			if n.Text == "本机自己的" {
				return n.ID
			}
		}
		return ""
	}()); !ok {
		t.Fatal("本机自有数据应保留")
	}
	if s.GCMedia() != 0 {
		t.Fatal("附件媒体不应被 GC")
	}
	// 再导一次：同 ID 覆盖，不重复
	if _, err := s.ImportTauri(tdir, tkey); err != nil || len(s.Notes()) != 4 {
		t.Fatalf("重复导入 %d %v", len(s.Notes()), err)
	}
}

func TestTauriClipCardTemplate(t *testing.T) {
	for in, want := range map[string]string{"standard": "standard", "condensed": "condensed", "banner": "condensed", "": "", "x": ""} {
		if got := applyTauriSettings(Settings{}, tauriSettings{ClipCardTemplate: in}).ClipTemplate; got != want {
			t.Errorf("%q → %q，应为 %q", in, got, want)
		}
	}
}
