package store

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/gif" // Tauri 媒体库里可能有 GIF / JPEG（截图与粘贴的图），统一转成 PNG 入原生媒体库
	_ "image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// 从 Tauri 版导入（toskr-data.json + media/）：两版信封格式与 AAD 相同（data_crypto.rs），只是密钥不同。
// 数据目录：~/Library/Application Support/com.toskr.app，若有 toskr-datadir.txt 指针则以指针为准。
// 导入前写恢复点；同 ID 以 Tauri 为准覆盖；合成测试数据（来源 Seed）一并清掉。

const tauriBundleDir = "com.toskr.app"

// TauriDataDir：Tauri 版当前生效的数据目录。
func TauriDataDir() string {
	home, _ := os.UserHomeDir()
	base := filepath.Join(home, "Library", "Application Support", tauriBundleDir)
	if b, err := os.ReadFile(filepath.Join(base, "toskr-datadir.txt")); err == nil {
		if p := strings.TrimSpace(string(b)); p != "" {
			return p
		}
	}
	return base
}

type tauriFile struct {
	State   tauriState `json:"state"`
	Version int        `json:"version"`
}

type tauriState struct {
	Sections     []tauriSection `json:"sections"`
	Notes        []tauriNote    `json:"notes"`
	Tasks        []tauriTask    `json:"tasks"`
	TaskSections []tauriSection `json:"taskSections"`
	Bills        []tauriBill    `json:"bills"`
	Settings     tauriSettings  `json:"settings"`
}

type tauriSection struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Collapsed     bool   `json:"collapsed"`
	Color         string `json:"color"`
	KeepAfterSend bool   `json:"keepAfterSend"`
}

type tauriNote struct {
	ID           string         `json:"id"`
	Kind         string         `json:"kind"`
	CodeLang     string         `json:"codeLang"`
	URL          string         `json:"url"`
	LinkTitle    string         `json:"linkTitle"`
	LinkIcon     string         `json:"linkIcon"`
	ImageFile    string         `json:"imageFile"`
	Attachments  []string       `json:"attachments"`
	Blocks       []ContentBlock `json:"contentBlocks"`
	ImageW       float64        `json:"imageW"`
	ImageH       float64        `json:"imageH"`
	Text         string         `json:"text"`
	SectionID    string         `json:"sectionId"`
	Done         bool           `json:"done"`
	Keep         bool           `json:"keep"`
	Blur         bool           `json:"blur"`
	Title        string         `json:"title"`
	Tags         []string       `json:"tags"`
	CreatedAt    int64          `json:"createdAt"`
	UpdatedAt    int64          `json:"updatedAt"`
	SourceApp    string         `json:"sourceApp"`
	SourceBundle string         `json:"sourceBundle"`
	Provenance   *Provenance    `json:"provenance"`
	SecretMeta   *struct {
		KeyID     *string `json:"keyId"`
		KeyLabel  string  `json:"keyLabel"`
		Direction string  `json:"direction"`
	} `json:"secretMeta"`
}

type tauriTask struct {
	ID          string          `json:"id"`
	Text        string          `json:"text"`
	Status      string          `json:"status"`
	Priority    string          `json:"priority"`
	DueAt       *int64          `json:"dueAt"`
	CreatedAt   int64           `json:"createdAt"`
	RemindedAt  *int64          `json:"remindedAt"`
	Note        string          `json:"note"`
	Checklist   []ChecklistItem `json:"checklist"`
	Kind        string          `json:"kind"`
	SectionID   string          `json:"sectionId"`
	CompletedAt int64           `json:"completedAt"`
	Recurrence  *struct {
		Freq  string `json:"freq"`
		Basis string `json:"basis"`
		Until int64  `json:"until"`
		Count int    `json:"count"`
	} `json:"recurrence"`
}

type tauriBill struct {
	ID            string   `json:"id"`
	Kind          string   `json:"kind"`
	Name          string   `json:"name"`
	IconFile      string   `json:"iconFile"`
	FallbackColor string   `json:"fallbackColor"`
	Amount        *float64 `json:"amount"`
	Currency      string   `json:"currency"`
	Category      string   `json:"category"`
	PayMethod     string   `json:"payMethod"`
	Cycle         string   `json:"cycle"`
	StartedAt     int64    `json:"startedAt"`
	NextDueAt     int64    `json:"nextDueAt"`
	Status        string   `json:"status"`
	Reminder      []int    `json:"reminderOffsets"`
	RemindedFor   struct {
		DueAt   int64 `json:"dueAt"`
		Offsets []int `json:"offsets"`
	} `json:"remindedFor"`
	History []struct {
		PeriodDueAt int64   `json:"periodDueAt"`
		Amount      float64 `json:"amount"`
		PaidAt      int64   `json:"paidAt"`
		Method      string  `json:"method"`
	} `json:"history"`
	Note      string `json:"note"`
	CreatedAt int64  `json:"createdAt"`
	CatalogID string `json:"catalogId"`
}

type tauriSettings struct {
	Language             string   `json:"language"`
	Theme                string   `json:"theme"`
	ColorScheme          string   `json:"colorScheme"`
	CardDensity          string   `json:"cardDensity"`
	HotkeyModifier       string   `json:"hotkeyModifier"`
	HotkeyGapMs          int      `json:"hotkeyGapMs"`
	Stealth              *bool    `json:"stealth"`
	AIBaseURL            string   `json:"aiBaseUrl"`
	AIModel              string   `json:"aiModel"`
	ExcludedApps         []string `json:"excludedApps"`
	CurrencySymbol       string   `json:"currencySymbol"`
	SubscriptionsEnabled *bool    `json:"subscriptionsEnabled"`
	SecretEnabled        *bool    `json:"secretEnabled"`
	SecretKeys           []struct {
		ID          string `json:"id"`
		Label       string `json:"label"`
		Passphrase  string `json:"passphrase"`
		Note        string `json:"note"`
		CreatedAtMs int64  `json:"createdAtMs"`
	} `json:"secretKeys"`
	SecretDefaultKeyID *string         `json:"secretDefaultKeyId"`
	SecretCipherStyle  string          `json:"secretCipherStyle"`
	SecretRevealMs     *int            `json:"secretRevealTimeoutMs"`
	PromptGroups       []PromptGroup   `json:"promptGroups"`
	TargetProfiles     []TargetProfile `json:"targetProfiles"`
	DefaultProfileID   string          `json:"defaultTargetProfileId"`
	PromptSnippets     []PromptSnippet `json:"promptSnippets"`
	NewNoteHotkey      *string         `json:"newNoteHotkey"`
	DoubleTapCapture   *bool           `json:"doubleTapCaptureOnly"`
	CaptureSectionID   *string         `json:"captureSectionId"`
	WindowOpacity      float64         `json:"windowOpacity"`
	PanelOpacity       float64         `json:"panelOpacity"`
	CardOpacity        float64         `json:"cardOpacity"`
	HUDDurationMs      int             `json:"hudDurationMs"`
	CompanionGap       *int            `json:"companionGap"`
	CardTint           *bool           `json:"cardTint"`
	ClipCardTemplate   string          `json:"clipCardTemplate"`
}

// TauriReport 是导入结果。
type TauriReport struct {
	Notes, Sections, Tasks, Bills, Secrets, Media, MediaMissing, SeedRemoved, Deliveries int
	Recovery                                                                             string
}

func ms(v int64) time.Time {
	if v <= 0 {
		return time.Time{}
	}
	return time.UnixMilli(v)
}

// ReadTauri 解开 Tauri 数据文件（key 为 Tauri 钥匙串里的 32 字节数据密钥；明文旧文件直通）。
func ReadTauri(dir string, key []byte) (*tauriState, error) {
	raw, err := os.ReadFile(filepath.Join(dir, "toskr-data.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrTauriMissing
	}
	if err != nil {
		return nil, err
	}
	plain := raw
	if Sealed(raw) {
		if plain, err = Open(key, PurposeData, raw); err != nil {
			return nil, fmt.Errorf("Tauri 数据解密失败（密钥不对或文件损坏）：%w", err)
		}
	}
	return parseTauriDoc(plain)
}

// ErrTauriEmpty：解开后没有任何笔记 / 分组 / 任务 / 账单——多半是格式没认出来，宁可报错也不动本机数据。
var ErrTauriEmpty = errors.New("Tauri 数据里没有可导入的内容（格式未识别或数据为空），未做任何改动")

// parseTauriDoc：toskr-data.json 是 Tauri 持久化层的「袋子」{"toskr": "<zustand 的 {state, version} JSON 字符串>"}
// （旧名 copper，同 persistStorage.ts valueFromBag）；也兼容直接是 {state, version} 的文档。
func parseTauriDoc(plain []byte) (*tauriState, error) {
	var bag map[string]json.RawMessage
	if err := json.Unmarshal(plain, &bag); err != nil {
		return nil, fmt.Errorf("Tauri 数据格式无法识别：%w", err)
	}
	doc := plain
	for _, name := range []string{"toskr", "copper"} {
		v, ok := bag[name]
		if !ok {
			continue
		}
		var s string
		if err := json.Unmarshal(v, &s); err != nil {
			return nil, fmt.Errorf("Tauri 持久化状态 %s 类型无效", name)
		}
		doc = []byte(s)
		break
	}
	var f tauriFile
	if err := json.Unmarshal(doc, &f); err != nil {
		return nil, fmt.Errorf("Tauri 数据格式无法识别：%w", err)
	}
	st := f.State
	if len(st.Notes) == 0 && len(st.Sections) == 0 && len(st.Tasks) == 0 && len(st.Bills) == 0 {
		return nil, ErrTauriEmpty
	}
	return &st, nil
}

// tauriMedia：读 Tauri 媒体文件、解密、统一成 PNG 存进原生媒体库，返回原生文件名（同名缓存）。
type tauriMedia struct {
	s       *Store
	dir     string
	key     []byte
	mapped  map[string]string
	missing int
}

func (m *tauriMedia) get(name string) string {
	if name == "" {
		return ""
	}
	if v, ok := m.mapped[name]; ok {
		return v
	}
	m.mapped[name] = ""
	if strings.ContainsAny(name, "/\\") || strings.HasPrefix(name, ".") {
		m.missing++
		return ""
	}
	raw, err := os.ReadFile(filepath.Join(m.dir, "media", name))
	if err == nil && Sealed(raw) {
		raw, err = Open(m.key, PurposeMedia, raw)
	}
	if err != nil {
		m.missing++
		return ""
	}
	if !bytes.HasPrefix(raw, []byte("\x89PNG")) {
		img, _, err := image.Decode(bytes.NewReader(raw))
		if err != nil {
			m.missing++
			return ""
		}
		var buf bytes.Buffer
		if png.Encode(&buf, img) != nil {
			m.missing++
			return ""
		}
		raw = buf.Bytes()
	}
	out, err := m.s.SaveImage(raw)
	if err != nil {
		m.missing++
		return ""
	}
	m.mapped[name] = out
	return out
}

// ImportTauri 导入 Tauri 版数据：先写恢复点；清掉合成测试数据；同 ID 以 Tauri 为准，其余并入。
func (s *Store) ImportTauri(dir string, key []byte) (TauriReport, error) {
	var rep TauriReport
	st, err := ReadTauri(dir, key)
	if err != nil {
		return rep, err
	}
	if rep.Recovery, err = s.WriteRecoveryPoint("pre-tauri-import", time.Now()); err != nil {
		return rep, fmt.Errorf("恢复点写入失败，已中止导入：%w", err)
	}
	m := &tauriMedia{s: s, dir: dir, key: key, mapped: map[string]string{}}

	var notes []Note
	var secrets []Secret
	for _, t := range st.Notes {
		if t.ID == "" {
			continue
		}
		if t.Kind == "secret" {
			sec := Secret{ID: t.ID, Text: t.Text, SourceApp: t.SourceApp, CreatedAt: ms(t.CreatedAt), Direction: "in"}
			if t.SecretMeta != nil {
				if t.SecretMeta.KeyID != nil {
					sec.KeyID = *t.SecretMeta.KeyID
				}
				sec.KeyLabel = t.SecretMeta.KeyLabel
				if t.SecretMeta.Direction != "" {
					sec.Direction = t.SecretMeta.Direction
				}
			}
			secrets = append(secrets, sec)
			continue
		}
		n := Note{ID: t.ID, Section: t.SectionID, Text: t.Text, SourceApp: t.SourceApp, BundleID: t.SourceBundle,
			CreatedAt: ms(t.CreatedAt), UpdatedAt: ms(t.UpdatedAt), Kept: t.Keep, Done: t.Done, Kind: t.Kind,
			LinkTitle: t.LinkTitle, Tags: t.Tags, ImageW: int(t.ImageW), ImageH: int(t.ImageH),
			Title: t.Title, Blur: t.Blur, URL: t.URL, LinkIcon: t.LinkIcon, CodeLang: t.CodeLang, Provenance: t.Provenance}
		if n.Kind == "text" {
			n.Kind = ""
		}
		if n.Section == "" {
			n.Section = SectionInbox
		}
		n.ImageFile = m.get(t.ImageFile)
		for _, f := range t.Attachments {
			if v := m.get(f); v != "" {
				n.Attachments = append(n.Attachments, v)
			}
		}
		for _, b := range t.Blocks {
			if b.Type == "image" {
				if b.File = m.get(b.File); b.File == "" {
					continue
				}
			}
			n.Blocks = append(n.Blocks, b)
		}
		if n.Kind == "image" && n.ImageFile == "" {
			if len(n.Attachments) == 0 && strings.TrimSpace(n.Text) == "" {
				continue // 图丢了又没有文字：导进来也是空卡
			}
			n.Kind = ""
		}
		if strings.TrimSpace(n.Text) == "" && n.ImageFile == "" && len(n.Attachments) == 0 && len(n.Blocks) == 0 {
			continue // 没字也没图才算空卡；只有附件 / 内容块里有图的照样导入
		}
		notes = append(notes, n)
	}
	var sections []Section
	for _, x := range st.Sections {
		if x.ID == "" || x.ID == "secret" {
			continue
		}
		sections = append(sections, Section{ID: x.ID, Name: x.Name, Color: x.Color, Collapsed: x.Collapsed, KeepAfterSend: x.KeepAfterSend})
	}
	var taskSecs []Section
	for _, x := range st.TaskSections {
		if x.ID != "" {
			taskSecs = append(taskSecs, Section{ID: x.ID, Name: x.Name, Collapsed: x.Collapsed})
		}
	}
	var tasks []Task
	for _, t := range st.Tasks {
		if t.ID == "" || strings.TrimSpace(t.Text) == "" {
			continue
		}
		x := Task{ID: t.ID, Text: t.Text, Status: t.Status, Priority: t.Priority, CreatedAt: ms(t.CreatedAt),
			CompletedAt: ms(t.CompletedAt), Note: t.Note, Checklist: t.Checklist, Spark: t.Kind == "spark", Section: t.SectionID}
		if t.DueAt != nil {
			x.DueAt = ms(*t.DueAt)
		}
		if t.RemindedAt != nil {
			x.RemindedAt = ms(*t.RemindedAt)
		}
		if t.Recurrence != nil {
			x.Recurrence, x.RecurBasis, x.RecurCount = t.Recurrence.Freq, t.Recurrence.Basis, t.Recurrence.Count
			if t.Recurrence.Until > 0 {
				x.RecurUntil = time.UnixMilli(t.Recurrence.Until)
			}
		}
		if x.Status == "" {
			x.Status = "todo"
		}
		if x.Priority == "" {
			x.Priority = "none"
		}
		tasks = append(tasks, x)
	}
	var bills []Bill
	for _, b := range st.Bills {
		if b.ID == "" {
			continue
		}
		x := Bill{ID: b.ID, Kind: b.Kind, Name: b.Name, Currency: b.Currency, Cycle: b.Cycle, NextDueAt: ms(b.NextDueAt),
			Status: b.Status, RemindDays: b.Reminder, PayMethod: b.PayMethod, IconFile: m.get(b.IconFile),
			FallbackColor: b.FallbackColor, Category: b.Category, Note: b.Note, StartedAt: ms(b.StartedAt),
			CreatedAt: ms(b.CreatedAt), CatalogID: b.CatalogID}
		if b.Amount != nil {
			x.Amount = *b.Amount
		}
		if b.RemindedFor.DueAt == b.NextDueAt {
			x.Reminded = b.RemindedFor.Offsets
		}
		for _, h := range b.History {
			x.History = append(x.History, Payment{At: ms(h.PaidAt), Amount: h.Amount, Period: ms(h.PeriodDueAt), Manual: h.Method == "manual"})
		}
		bills = append(bills, x)
	}

	acts := readTauriActivity(dir, st.Settings.TargetProfiles)
	err = s.mutate(func() bool {
		rep.Deliveries = mergeDeliveries(&s.deliveries, acts)
		before := len(s.notes)
		s.notes = slices.DeleteFunc(s.notes, func(n Note) bool { return n.SourceApp == "Seed" })
		rep.SeedRemoved = before - len(s.notes)
		rep.Notes = upsert(&s.notes, notes, func(n Note) string { return n.ID })
		rep.Sections = upsertSections(&s.sections, sections)
		upsertSections(&s.taskSections, taskSecs)
		rep.Tasks = upsert(&s.tasks, tasks, func(t Task) string { return t.ID })
		rep.Bills = upsert(&s.bills, bills, func(b Bill) string { return b.ID })
		rep.Secrets = upsert(&s.secrets, secrets, func(x Secret) string { return x.ID })
		s.settings = applyTauriSettings(s.settings, st.Settings)
		return true
	})
	if err != nil {
		return rep, err
	}
	s.ensureDefaults()
	rep.Media = len(m.mapped) - m.missing
	rep.MediaMissing = m.missing
	return rep, s.Flush()
}

// upsert：按 ID 覆盖已有项，新项按 Tauri 顺序追加；返回导入条数。
func upsert[T any](cur *[]T, in []T, id func(T) string) int {
	at := map[string]int{}
	for i, x := range *cur {
		at[id(x)] = i
	}
	for _, x := range in {
		if i, ok := at[id(x)]; ok {
			(*cur)[i] = x
		} else {
			at[id(x)] = len(*cur)
			*cur = append(*cur, x)
		}
	}
	return len(in)
}

// upsertSections：分组顺序以 Tauri 为准（Tauri 有的按其顺序排前，本机独有的保留在后），剪贴板固定最后。
func upsertSections(cur *[]Section, in []Section) int {
	if len(in) == 0 {
		return 0
	}
	seen := map[string]bool{}
	var out []Section
	for _, x := range in {
		if !seen[x.ID] {
			seen[x.ID] = true
			out = append(out, x)
		}
	}
	for _, x := range *cur {
		if !seen[x.ID] {
			out = append(out, x)
		}
	}
	if i := slices.IndexFunc(out, func(x Section) bool { return x.ID == SectionClipboard }); i >= 0 && i != len(out)-1 {
		c := out[i]
		out = append(slices.Delete(out, i, i+1), c)
	}
	*cur = out
	return len(in)
}

func applyTauriSettings(st Settings, t tauriSettings) Settings {
	set := func(dst *string, v string) {
		if v != "" {
			*dst = v
		}
	}
	set(&st.Language, t.Language)
	set(&st.Theme, t.Theme)
	set(&st.ColorScheme, t.ColorScheme)
	set(&st.CardDensity, t.CardDensity)
	set(&st.TriggerModifier, t.HotkeyModifier)
	set(&st.AIEndpoint, t.AIBaseURL)
	set(&st.AIModel, t.AIModel)
	set(&st.Currency, t.CurrencySymbol)
	set(&st.SecretCipherStyle, t.SecretCipherStyle)
	if t.HotkeyGapMs > 0 {
		st.TriggerGapMs = t.HotkeyGapMs
	}
	if t.WindowOpacity > 0 {
		st.WindowOpacity = t.WindowOpacity
	}
	if t.PanelOpacity > 0 {
		st.PanelOpacity = t.PanelOpacity
	}
	if t.CardOpacity > 0 {
		st.CardOpacity = t.CardOpacity
	}
	if t.HUDDurationMs > 0 {
		st.HUDDurationMs = t.HUDDurationMs
	}
	if t.CompanionGap != nil {
		st.CompanionGap = t.CompanionGap
	}
	if t.CardTint != nil {
		st.CardTintOff = !*t.CardTint
	}
	switch t.ClipCardTemplate { // Tauri 旧值 banner 已并入浓缩
	case "standard", "condensed":
		st.ClipTemplate = t.ClipCardTemplate
	case "banner":
		st.ClipTemplate = "condensed"
	}
	if t.DoubleTapCapture != nil {
		st.DoubleTapCaptureOnly = *t.DoubleTapCapture
	}
	if t.CaptureSectionID != nil {
		st.CaptureSection = *t.CaptureSectionID
	}
	if t.NewNoteHotkey != nil {
		st.NewNoteKey = TauriAccel(*t.NewNoteHotkey)
	}
	if len(t.TargetProfiles) > 0 { // 发送方案整组以 Tauri 为准
		st.PromptGroups, st.TargetProfiles, st.DefaultProfileID = t.PromptGroups, t.TargetProfiles, t.DefaultProfileID
	}
	for _, sn := range t.PromptSnippets { // 模板按 ID 合并，同 ID 以 Tauri 为准
		if i := slices.IndexFunc(st.PromptSnippets, func(x PromptSnippet) bool { return x.ID == sn.ID }); i >= 0 {
			st.PromptSnippets[i] = sn
		} else if sn.ID != "" {
			st.PromptSnippets = append(st.PromptSnippets, sn)
		}
	}
	if t.Stealth != nil {
		st.Stealth = *t.Stealth
	}
	if t.SubscriptionsEnabled != nil {
		st.SubscriptionsEnabled = *t.SubscriptionsEnabled
	}
	if t.SecretEnabled != nil {
		st.SecretEnabled = *t.SecretEnabled
	}
	if t.SecretRevealMs != nil {
		st.SecretRevealMs = *t.SecretRevealMs
	}
	if t.SecretDefaultKeyID != nil {
		st.SecretDefaultKeyID = *t.SecretDefaultKeyID
	}
	for _, x := range t.ExcludedApps {
		if !slices.Contains(st.ExcludedApps, x) {
			st.ExcludedApps = append(st.ExcludedApps, x)
		}
	}
	for _, k := range t.SecretKeys {
		if k.ID == "" || slices.ContainsFunc(st.SecretKeys, func(x SecretKey) bool { return x.ID == k.ID }) {
			continue
		}
		st.SecretKeys = append(st.SecretKeys, SecretKey{ID: k.ID, Label: k.Label, Passphrase: k.Passphrase, Note: k.Note, CreatedAt: ms(k.CreatedAtMs)})
	}
	return st
}

// ErrTauriMissing：本机没有 Tauri 版数据。
var ErrTauriMissing = errors.New("没有找到 Tauri 版数据（toskr-data.json）")

// TauriAccel 把 Tauri 的 KeyboardEvent.code 写法（Cmd+Shift+KeyN、Alt+Digit1）转成原生加速键（Cmd+Shift+N）。
func TauriAccel(s string) string {
	parts := strings.Split(s, "+")
	for i, p := range parts {
		switch {
		case strings.HasPrefix(p, "Key") && len(p) == 4:
			parts[i] = p[3:]
		case strings.HasPrefix(p, "Digit") && len(p) == 6:
			parts[i] = p[5:]
		case strings.HasPrefix(p, "Arrow"):
			parts[i] = p[5:]
		}
	}
	return strings.Join(parts, "+")
}
