package main

import (
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/macos"
	"github.com/toskr/native/internal/store"
)

// 同时问多个 AI（原生版新增）：详情窗发送下拉「同时发到…」勾 2–3 个运行中的应用，依次切换目标、逐个走完整的发送管线
// （每个目标按自己的粘贴规则与隐私检查）；这一组发送记同一个编号。之后从这些应用捕获的回复自动关联到对应的那次发送，
// 收到两家以上就能在详情窗并排对比：各家都说到的内容压淡，只有一家说到的保持正常并加浅底。
// 回复仍要自己在目标应用里选中后双击触发键捕获（没有自动抓取回复）。

const fanoutMax = 3

type fanout struct {
	id         string
	targets    []macos.AppInfo
	idx        int
	notes      []store.Note
	sent       []string // 已发成功的应用名
	delivering bool     // 当前目标已进入投递（deliver 已启动）
}

// startFanout：依次发到 targets。
func (a *app) startFanout(notes []store.Note, targets []macos.AppInfo) {
	if len(notes) == 0 || len(targets) < 2 || a.fanout != nil {
		return
	}
	a.fanout = &fanout{id: fmt.Sprintf("fan-%d", a.now().UnixNano()), targets: targets, notes: notes}
	a.fanoutStep()
}

// fanoutStep：切到下一个目标并发送；这个目标没能进入发送（不可用 / 方案待确认）就跳过。
func (a *app) fanoutStep() {
	f := a.fanout
	for f != nil && f.idx < len(f.targets) {
		t := f.targets[f.idx]
		f.delivering = false
		if a.adoptTarget(t) {
			a.send(f.notes)
			if f.delivering || len(a.pending) > 0 || len(a.enterAsk) > 0 {
				return // 已在投递，或停在预检 / 回车确认里等用户
			}
		}
		f.idx++ // 没发出去：下一个
	}
	a.finishFanout()
}

// fanoutDelivered：一个目标投递结束（deliver 的收尾里调用）。
func (a *app) fanoutDelivered(ok bool) {
	f := a.fanout
	if f == nil || !f.delivering {
		return
	}
	if ok {
		f.sent = append(f.sent, f.targets[f.idx].Name)
	}
	f.idx++
	a.fanoutStep()
}

func (a *app) finishFanout() {
	f := a.fanout
	if f == nil {
		return
	}
	a.fanout = nil
	switch len(f.sent) {
	case 0:
		a.showHUD("warn", tr("没有发到任何应用"))
	case len(f.targets):
		a.showHUD("sent", fmt.Sprintf(tr("已发到 %s"), strings.Join(f.sent, "、")))
	default:
		a.showHUD("warn", fmt.Sprintf(tr("只发到了 %s（共选了 %d 个）"), strings.Join(f.sent, "、"), len(f.targets)))
	}
}

// cancelFanout：用户在预检 / 回车确认里取消——停在这里，后面的目标不再发。
func (a *app) cancelFanout() {
	f := a.fanout
	if f == nil || f.delivering {
		return
	}
	a.fanout = nil
	if len(f.sent) > 0 {
		a.showHUD("info", fmt.Sprintf(tr("已停止；之前已发到 %s"), strings.Join(f.sent, "、")))
	}
}

// ---- 选目标的浮层（详情窗） ----

func (a *app) fanPicked(apps []macos.AppInfo) []macos.AppInfo {
	var out []macos.AppInfo
	for _, app := range apps {
		if slices.Contains(a.fanPick, app.BundleID) {
			out = append(out, app)
		}
	}
	return out
}

// fanoutPicker：操作坞上方的浮层——勾应用（最多 3 个），一个全宽主按钮，取消降为文字链接。
func (a *app) fanoutPicker(c *ui.Context, k tokens, n store.Note) {
	if !a.detail.fanOpen {
		return
	}
	apps := runningTargets()
	picked := a.fanPicked(apps)
	box := floatSurface(ui.Column(c).Absolute().Bottom(64).Right(16).Width(252).Padding(10).Gap(8).Radius(12), k).Key("fanout-picker").Label(tr("同时发到"))
	box.Children(func() {
		ui.Row(c).AlignItems(ui.Center).Children(func() {
			text(c, tr("同时发到"), 12, 17, 600, k.fg).Grow(1).Basis(0)
			text(c, fmt.Sprintf(tr("已选 %d / %d"), len(picked), fanoutMax), 10, 14, 400, k.muted)
		})
		if len(apps) == 0 {
			text(c, tr("暂无其他可用应用"), 11, 16, 400, k.muted)
		}
		_, vh := c.Size()
		ui.Scroll(c).MaxHeight(max(120, vh-260)).Scrollbars(false).Children(func() {
			ui.Column(c).Gap(1).Children(func() {
				for _, app := range apps {
					on := slices.Contains(a.fanPick, app.BundleID)
					full := !on && len(picked) >= fanoutMax
					row := ui.Row(c).Height(28).Padding(0, 6).Gap(8).Radius(7).AlignItems(ui.Center).Key("fan-" + app.BundleID).Role(ui.RoleButton).Label(app.Name)
					switch { // 选中只用浅底 + 对勾，不铺整块主色
					case full:
						row.Opacity(0.45)
					case on:
						row.Background(k.track)
					case row.Hovered():
						row.Background(k.hoverBg)
					}
					row.Children(func() {
						if img := a.appIcon(app.BundleID); img != nil {
							ui.Image(c, img).Size(18, 18)
						} else {
							ui.Box(c).Size(18, 18).Radius(4).Background(k.track)
						}
						text(c, app.Name, 12, 17, 400, k.fg).SingleLine().Grow(1).Basis(0)
						if on {
							licon(c, "check", 13, k.fg)
						}
					})
					if row.Clicked() && !full {
						if on {
							a.fanPick = slices.DeleteFunc(a.fanPick, func(b string) bool { return b == app.BundleID })
						} else {
							a.fanPick = append(a.fanPick, app.BundleID)
						}
					}
				}
			})
		})
		label := tr("至少选 2 个应用")
		if len(picked) >= 2 {
			label = fmt.Sprintf(tr("发到 %d 个应用"), len(picked))
		}
		btn := ui.Row(c).Height(32).Radius(10).Justify(ui.Center).AlignItems(ui.Center).Key("fan-go").Role(ui.RoleButton).Label(label)
		st := stok(c)
		btn.Background(st.btn).Border(1, st.btnBorder).Shadow(0, 1, 2, 0, st.btnShadow)
		if len(picked) < 2 {
			btn.Opacity(0.5)
		} else if btn.Hovered() {
			btn.Background(st.btnHover)
		}
		btn.Children(func() {
			licon(c, "send", 13, st.btnFg)
			ui.Box(c).Width(6)
			text(c, label, 12, 17, 600, st.btnFg)
		})
		if btn.Clicked() && len(picked) >= 2 {
			a.detail.fanOpen = false
			if a.detail.edit {
				if !a.commitDetailEdit(n) {
					return
				}
				n.Text = a.detailText
			}
			a.startFanout([]store.Note{n}, picked)
			if !a.detail.pinned {
				a.closeDetailWin()
			}
		}
		ui.Row(c).Justify(ui.Center).Children(func() {
			if reviewLink(c, k, "fan-cancel", tr("取消")) {
				a.detail.fanOpen = false
			}
		})
	})
}

// ---- 回复自动关联与并排对比 ----

// fanoutReplies：同一组发送里已关联回复的各家（按发送顺序）。
func (a *app) fanoutReplies(id string) []compareCol {
	if id == "" {
		return nil
	}
	var out []compareCol
	ds := a.store.Deliveries()
	slices.SortStableFunc(ds, func(x, y store.Delivery) int { return x.At.Compare(y.At) })
	for _, d := range ds {
		if d.Fanout != id || d.ResultNoteID == "" {
			continue
		}
		if n, ok := a.store.Note(d.ResultNoteID); ok {
			out = append(out, compareCol{app: d.TargetName, bundle: d.TargetBundle, note: n})
		}
	}
	return out
}

// fanoutOf：这张回复卡所属的那组发送（不是多目标发送的回复返回空）。
func (a *app) fanoutOf(n store.Note) string {
	if n.Provenance == nil {
		return ""
	}
	for _, d := range a.store.Deliveries() {
		if d.ID == n.Provenance.DeliveryID {
			return d.Fanout
		}
	}
	return ""
}

// autoLinkFanoutReply：捕获到的内容来自某次多目标发送的目标应用、且只有这一次候选、还没有回复 → 直接关联。
// 返回提示文字（空 = 没有关联）。
func (a *app) autoLinkFanoutReply(n store.Note) string {
	ds := store.DeliveryCandidates(n, a.store.Deliveries())
	if len(ds) != 1 || ds[0].Fanout == "" || ds[0].ResultNoteID != "" {
		return ""
	}
	if _, ok := a.store.LinkResult(ds[0].ID, n.ID); !ok {
		return ""
	}
	a.store.RecordOutcome(store.OutcomeEvent{DeliveryID: ds[0].ID, Type: store.OutResult, AtMs: n.CreatedAt.UnixMilli()})
	if got := len(a.fanoutReplies(ds[0].Fanout)); got >= 2 {
		return fmt.Sprintf(tr("已收为 %s 的回复 · 已有 %d 家，右键可对比"), ds[0].TargetName, got)
	}
	return fmt.Sprintf(tr("已收为 %s 的回复"), ds[0].TargetName)
}

type compareCol struct {
	app, bundle string
	note        store.Note
}

// openReplyCompare：在详情窗里并排对比这一组的回复。
func (a *app) openReplyCompare(id string) {
	cols := a.fanoutReplies(id)
	if len(cols) < 2 {
		a.showHUD("info", tr("至少收到两家的回复才能对比"))
		return
	}
	openDetailFn(a, cols[0].note)
	a.detail.compare = id
}

// compareLines：各列按非空行切开，并标出每行是不是「各家都有」。
func compareLines(texts []string) [][]compareLine {
	norm := func(s string) string { return strings.Join(strings.Fields(s), " ") }
	count := map[string]int{}
	split := make([][]string, len(texts))
	for i, t := range texts {
		seen := map[string]bool{}
		for _, l := range strings.Split(strings.ReplaceAll(t, "\r\n", "\n"), "\n") {
			if strings.TrimSpace(l) == "" {
				continue
			}
			split[i] = append(split[i], l)
			if k := norm(l); !seen[k] {
				seen[k] = true
				count[k]++
			}
		}
	}
	out := make([][]compareLine, len(texts))
	for i, ls := range split {
		for _, l := range ls {
			out[i] = append(out[i], compareLine{text: l, common: count[norm(l)] == len(texts)})
		}
	}
	return out
}

type compareLine struct {
	text   string
	common bool
}

// compareView：详情窗的对比视图（整窗）。Esc / ⌘W 回到这张卡。
func (a *app) compareView(c *ui.Context, k tokens) {
	cols := a.fanoutReplies(a.detail.compare)
	if len(cols) < 2 || c.Shortcut(0, ui.KeyEscape) {
		a.detail.compare = ""
		c.Invalidate()
		return
	}
	if c.Shortcut(ui.Cmd, ui.KeyW) {
		a.closeDetailWin()
		return
	}
	texts := make([]string, len(cols))
	for i, col := range cols {
		texts[i] = col.note.Text
	}
	lines := compareLines(texts)
	fs := a.detailFS()
	root := ui.Column(c).Fill().Key("reply-compare").Label(tr("对比回复"))
	root.Children(func() {
		ui.Row(c).Height(40).Padding(0, 16, 0, 84).AlignItems(ui.Center).DragWindow().Children(func() {
			text(c, fmt.Sprintf(tr("对比回复 · %d 个应用"), len(cols)), 12, 17, 600, k.fg).Grow(1).Basis(0)
			if reviewLink(c, k, "cmp-close", tr("返回这张卡")) {
				a.detail.compare = ""
			}
		})
		ui.Scroll(c).Grow(1).Scrollbars(false).Children(func() {
			ui.Row(c).Padding(4, 16, 20, 16).Gap(12).AlignItems(ui.Start).Children(func() {
				for i, col := range cols {
					ui.Column(c).Grow(1).Basis(0).Gap(4).Key("cmp-" + itoa(i)).Children(func() {
						ui.Row(c).Height(26).Gap(6).AlignItems(ui.Center).Padding(0, 0, 4, 0).BorderWidth(0, 0, 1, 0).BorderColor(k.fg.Alpha(0.1)).Children(func() {
							if img := a.appIcon(col.bundle); img != nil {
								ui.Image(c, img).Size(16, 16)
							}
							text(c, col.app, 12, 17, 600, k.fg).SingleLine().Shrink(1)
							text(c, fmt.Sprintf(tr("%d 字"), utf8.RuneCountInString(col.note.Text)), 10, 14, 400, k.muted).SingleLine().Grow(1).Basis(0)
							if reviewLink(c, k, "cmp-copy-"+itoa(i), tr("复制")) {
								a.copyPrivate(col.note.Text)
								a.showHUD("ok", tr("已复制"))
							}
						})
						for j, l := range lines[i] {
							t := text(c, l.text, fs, fs*1.625, 400, k.fg).Wrap().Key("l" + itoa(j))
							if l.common { // 各家都说到：压淡
								t.TextColor(k.muted)
							} else { // 只有这家（或不是每家都有）：浅底
								t.Padding(1, 4).Margin(0, -4).Radius(4).Background(k.amberBar.Alpha(0.12))
							}
						}
					})
				}
			})
		})
		text(c, tr("浅底：不是每家都说到的内容；灰字：各家一致"), 10, 14, 400, k.muted).Padding(6, 16, 10, 16)
	})
}
