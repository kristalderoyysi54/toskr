package main

import (
	"embed"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/store"
)

// 添加 / 编辑订阅（同 Tauri components/subscriptions/AddBillFlow.tsx）：盖住面板的对话框，新建先选预置服务
// （分类胶囊 + 搜索 + 品牌图标三列网格，或自定义订阅 / 信用卡），再确认信息；编辑直达表单。
// 品牌图标是 Tauri 同一套 App Store artwork（resources/brand-icons，按目录 id 查找）。

//go:embed resources/brand-icons/*.png
var brandIconFS embed.FS

type catalogService struct{ ID, Name, NameAlt, Domain, Category, Cycle string }

var catalogCategories = []string{"entertainment", "music", "ai", "productivity", "dev", "cloud", "creditCard", "other"}

var catalogCategoryLabel = map[string]string{"entertainment": "娱乐", "music": "音乐", "productivity": "生产力", "dev": "开发",
	"ai": "AI", "cloud": "云存储", "creditCard": "信用卡", "other": "其他"}

// currencyOptions 同 Tauri CURRENCY_OPTIONS（符号即存储值）。
var currencyOptions = [][2]string{{"¥", "¥ CNY"}, {"US$", "US$ USD"}, {"€", "€ EUR"}, {"£", "£ GBP"}, {"HK$", "HK$ HKD"}, {"JP¥", "JP¥ JPY"}}

var billOffsetOptions = []int{7, 3, 1, 0}

var brandIcons = map[string]ui.ImageSource{}

// brandIcon：目录 id → 内置品牌图；没有返回 nil（回退首字色块）。
func brandIcon(id string) ui.ImageSource {
	if id == "" {
		return nil
	}
	if img, ok := brandIcons[id]; ok {
		return img
	}
	var img ui.ImageSource
	if raw, err := brandIconFS.ReadFile("resources/brand-icons/" + id + ".png"); err == nil {
		img, _ = ui.DecodeImage(raw)
	}
	brandIcons[id] = img
	return img
}

type billForm struct {
	focusName bool // 进确认页首帧聚焦名称（同 Tauri 名称为空时 autoFocus）
	open      bool
	step      string // pick | confirm
	cat       string // 目录分类筛选，"" = 全部
	query     string
	id        string // 编辑中的账单
	kind      int    // 0 订阅 1 信用卡
	name      string
	amount    string
	currency  string
	category  string
	cycle     int
	due       time.Time
	start     time.Time
	repayDay  string
	method    string
	remind    []int
	note      string
	catalog   string
	created   store.Bill
}

func (a *app) openBillForm(b *store.Bill) {
	f := billForm{open: true, step: "pick", currency: cmpOr(a.store.Settings().Currency, "¥")}
	if b != nil {
		f.step, f.id, f.created = "confirm", b.ID, *b
		f.name, f.method, f.remind, f.note, f.catalog = b.Name, b.PayMethod, slices.Clone(b.RemindDays), b.Note, b.CatalogID
		f.currency, f.category = cmpOr(b.Currency, f.currency), cmpOr(b.Category, "other")
		f.cycle = max(0, slices.Index(cycleNames, b.Cycle))
		f.due, f.start, f.repayDay = b.NextDueAt, b.StartedAt, itoa(b.NextDueAt.Day())
		if b.Amount != 0 || b.Kind != "creditCard" { // 同 Tauri：订阅金额 0 显示 "0"（信用卡 0 = 留空只提醒）
			f.amount = fmtAmount(b.Amount)
		}
		if b.Kind == "creditCard" {
			f.kind = 1
		}
	}
	a.billForm = f
}

// usedPayMethods 同 Tauri：从既有账单提取，最近创建的在前，最多 5 个。
func (a *app) usedPayMethods() []string {
	type pm struct {
		v  string
		at time.Time
	}
	var list []pm
	for _, b := range a.store.Bills() {
		v := strings.TrimSpace(b.PayMethod)
		if v == "" {
			continue
		}
		if i := slices.IndexFunc(list, func(x pm) bool { return x.v == v }); i >= 0 {
			if b.CreatedAt.After(list[i].at) {
				list[i].at = b.CreatedAt
			}
			continue
		}
		list = append(list, pm{v, b.CreatedAt})
	}
	slices.SortStableFunc(list, func(x, y pm) int { return y.at.Compare(x.at) })
	var out []string
	for _, x := range list[:min(5, len(list))] {
		out = append(out, x.v)
	}
	return out
}

// startConfirm 同 Tauri startConfirm：从目录条目或「自定义」进入确认表单，带上默认值。
func (a *app) startConfirm(s *catalogService, credit bool) {
	f := &a.billForm
	now := dayStart(a.now())
	f.step, f.kind, f.name, f.amount, f.note, f.catalog = "confirm", 0, "", "", "", ""
	f.category, f.cycle, f.due, f.start, f.repayDay = "other", 1, now, now, "10"
	f.remind = a.store.Settings().BillDefaultRemind() // 同 Tauri billDefaultReminderOffsets（设置 → 提醒「账单默认提醒」）
	f.focusName = true
	if pms := a.usedPayMethods(); len(pms) > 0 {
		f.method = pms[0]
	} else {
		f.method = ""
	}
	if credit {
		f.kind = 1
	}
	if s != nil {
		f.name, f.catalog = s.Name, s.ID
		if s.Category == "creditCard" {
			f.kind = 1
		} else {
			f.category = s.Category
		}
		if i := slices.Index(cycleNames, s.Cycle); i >= 0 {
			f.cycle = i
		}
	}
}

func (a *app) billFlow(c *ui.Context, k tokens) {
	f := &a.billForm
	if !f.open {
		return
	}
	if c.Shortcut(0, ui.KeyEscape) {
		*f = billForm{}
		return
	}
	s := stok(c)
	w, h := c.Size()
	ui.Overlay(c, func() {
		ui.Box(c).Absolute().Left(0).Top(0).Size(w, h).Background(s.bg.Alpha(0.55)).Key("bill-flow-dim")
		sheet := ui.Column(c).Absolute().Left(8).Top(8).Size(w-16, h-16).Padding(12).Radius(16).Background(k.card).
			Border(1, k.floatBorder).Shadow(0, 12, 32, -8, k.floatShadowB).Shadow(0, 2, 6, 0, k.floatShadowA).Key("bill-flow").
			Transition(ui.ElementTransition{Duration: 100 * time.Millisecond, Ease: easeCSS, Enter: &ui.Motion{Y: 8}})
		sheet.Children(func() {
			ui.Row(c).Gap(4).Padding(0, 0, 8, 0).BorderWidth(0, 0, 1, 0).BorderColor(k.inputBorder).AlignItems(ui.Center).Children(func() {
				if f.step == "confirm" && f.id == "" && a.iconButton(c, k, "chevron-left", 24, 14, tr("返回服务目录")) {
					f.step = "pick"
				}
				title := tr("确认信息")
				switch {
				case f.id != "":
					title = tr("编辑订阅")
				case f.step == "pick":
					title = tr("添加订阅")
				}
				text(c, title, 13, 18, 600, k.fg).SingleLine().Grow(1)
				if a.iconButton(c, k, "x", 24, 14, tr("关闭")) {
					*f = billForm{}
				}
			})
			if !f.open {
				return
			}
			if f.step == "pick" {
				a.billPick(c, k, s)
			} else {
				a.billConfirm(c, k, s)
			}
		})
	})
}

func pill(c *ui.Context, k tokens, s settingsTokens, key, label string, on bool) bool {
	b := ui.Box(c).Height(20).Padding(0, 8).Radius(10).Center().Key(key).Role(ui.RoleButton).Label(label)
	fg := k.muted
	if on {
		b.Background(s.primary)
		fg = gray(1, 1)
	} else {
		b.Background(k.fg.Alpha(0.05))
		if b.Hovered() {
			fg = k.fg
		}
	}
	b.Children(func() { text(c, label, 11, 16, 500, fg).SingleLine() })
	return b.Clicked()
}

func (a *app) billPick(c *ui.Context, k tokens, s settingsTokens) {
	f := &a.billForm
	ui.Column(c).Margin(8, 0, 0, 0).Children(func() { // 面板窄时换行（Tauri 是横向滚动，mygo 无横向滚动容器）
		ui.Row(c).Wrap().Gap(4).Children(func() {
			if pill(c, k, s, "cat-all", tr("全部"), f.cat == "") {
				f.cat = ""
			}
			for _, cat := range catalogCategories {
				if pill(c, k, s, "cat-"+cat, tr(catalogCategoryLabel[cat]), f.cat == cat) {
					f.cat = cat
				}
			}
		})
	})
	ui.Row(c).Height(30).Margin(6, 0, 0, 0).Padding(0, 8).Gap(6).Radius(8).Border(1, k.inputBorder).AlignItems(ui.Center).Children(func() {
		licon(c, "search", 14, k.muted)
		ui.TextInputBase(c, &f.query).Grow(1).Font(fontSans).FontSize(12).FixedLineHeight(17).TextColor(k.fg).
			PlaceholderColor(k.muted).Placeholder(tr("搜索服务…")).Label(tr("搜索预置服务"))
	})
	q := strings.ToLower(strings.TrimSpace(f.query))
	var matches []catalogService
	for _, sv := range billCatalog {
		if (f.cat == "" || sv.Category == f.cat) && (q == "" || strings.Contains(strings.ToLower(sv.Name), q) ||
			strings.Contains(strings.ToLower(sv.NameAlt), q) || strings.Contains(sv.ID, q)) {
			matches = append(matches, sv)
		}
	}
	ui.Scroll(c).Grow(1).Margin(8, 0, 0, 0).Scrollbars(false).Children(func() {
		if len(matches) == 0 {
			text(c, tr("没有匹配的服务，用下方自定义添加"), 11, 16, 400, k.muted).Padding(32, 0).TextAlign(ui.Center).FillWidth()
			return
		}
		ui.Column(c).Gap(6).Padding(0, 0, 8, 0).Children(func() {
			for i := 0; i < len(matches); i += 3 {
				ui.Row(c).Gap(6).Key("crow-" + itoa(i)).Children(func() {
					for _, sv := range matches[i:min(i+3, len(matches))] {
						cell := ui.Column(c).Grow(1).Basis(0).Padding(10, 4).Gap(6).Radius(12).AlignItems(ui.Center).Key("svc-" + sv.ID).
							Role(ui.RoleButton).Label(sv.Name)
						cell.Background(k.fg.Alpha(map[bool]float32{true: 0.1, false: 0.05}[cell.Hovered()]))
						cell.Children(func() {
							billLogo(c, sv.ID, sv.Name, 32)
							text(c, sv.Name, 10, 14, 400, k.fg).SingleLine().TextAlign(ui.Center).FillWidth()
						})
						if cell.Clicked() {
							sv := sv
							a.startConfirm(&sv, false)
						}
					}
					for j := len(matches[i:min(i+3, len(matches))]); j < 3; j++ {
						ui.Box(c).Grow(1).Basis(0)
					}
				})
			}
		})
	})
	ui.Row(c).Gap(6).Padding(8, 2, 2, 2).BorderWidth(1, 0, 0, 0).BorderColor(k.inputBorder).Children(func() {
		ui.Column(c).Grow(1).Basis(0).Children(func() {
			if wideButton(c, s, "plus", tr("自定义订阅")) {
				a.startConfirm(nil, false)
			}
		})
		ui.Column(c).Grow(1).Basis(0).Children(func() {
			if wideButton(c, s, "plus", tr("自定义信用卡")) {
				a.startConfirm(nil, true)
			}
		})
	})
}

// wideButton：撑满宽度的 Button（default 变体：白底灰描边，同发送按钮）。
func wideButton(c *ui.Context, s settingsTokens, icon, label string) bool {
	b := ui.Row(c).Height(28).Padding(0, 10).Gap(4).Radius(10).Border(1, s.btnBorder).Justify(ui.Center).AlignItems(ui.Center).Key("wb-" + label).
		Role(ui.RoleButton).Label(label)
	bg := s.btn
	if b.Hovered() {
		bg = s.btnHover
	}
	b.Background(bg).Shadow(0, 1, 2, 0, s.btnShadow)
	b.Children(func() {
		if icon != "" {
			licon(c, icon, 13, s.btnFg)
		}
		text(c, label, 12, 17, 500, s.btnFg)
	})
	return b.Clicked()
}

// formField：标签在上、控件通栏（同 Tauri Field）。
func formField(c *ui.Context, k tokens, label string, body func()) {
	ui.Column(c).Gap(4).Key("ff-" + label).Children(func() {
		text(c, label, 10, 14, 400, k.muted)
		body()
	})
}

func formInput(c *ui.Context, k tokens, v *string, ph string) ui.Element {
	var in ui.Element
	ui.Row(c).Height(28).Padding(0, 8).Radius(6).Border(1, k.inputBorder).AlignItems(ui.Center).Children(func() {
		in = ui.TextInputBase(c, v).Grow(1).Font(fontSans).FontSize(12).FixedLineHeight(17).TextColor(k.fg).PlaceholderColor(k.muted).Placeholder(ph)
	})
	return in
}

// formSelect：表单下拉（同 Tauri FormSelect：描边 + 下拉箭头，菜单是应用内浮层）。
func formSelect(c *ui.Context, k tokens, key, label string, w float32, menu func(m *ui.Menu)) {
	b := ui.Row(c).Height(28).Padding(0, 8).Gap(4).Radius(6).Border(1, k.inputBorder).AlignItems(ui.Center).Key(key).Role(ui.RoleButton).Label(label)
	if w > 0 {
		b.Width(w)
	} else {
		b.FillWidth()
	}
	if b.Hovered() {
		b.Background(k.track)
	}
	b.Children(func() {
		text(c, label, 12, 17, 400, k.fg).SingleLine().Grow(1).Basis(0)
		licon(c, "chevron-down", 12, k.muted)
	})
	b.PopoverMenuButton(menu)
}

func (a *app) billConfirm(c *ui.Context, k tokens, s settingsTokens) {
	f := &a.billForm
	ui.Scroll(c).Grow(1).Margin(8, 0, 0, 0).Scrollbars(false).Children(func() {
		ui.Column(c).Gap(10).Padding(0, 2, 2, 2).Children(func() {
			if f.id == "" {
				ui.Row(c).Children(func() { segmented(c, k, &f.kind, tr("订阅"), tr("信用卡")) })
			}
			credit := f.kind == 1
			formField(c, k, tr("名称"), func() {
				ph := tr("如 Netflix")
				if credit {
					ph = tr("如 招商银行信用卡")
				}
				if in := formInput(c, k, &f.name, ph); f.focusName {
					if f.name == "" {
						in.Focus()
					}
					f.focusName = false
				}
			})
			amtLabel, amtPh := tr("每期金额"), "68"
			if credit {
				amtLabel, amtPh = tr("金额（可留空，每期可改）"), tr("留空 = 只提醒还款日")
			}
			formField(c, k, amtLabel, func() {
				ui.Row(c).Gap(6).Children(func() {
					cur := f.currency
					for _, o := range currencyOptions {
						if o[0] == f.currency {
							cur = o[1]
						}
					}
					formSelect(c, k, "bf-cur", cur, 104, func(m *ui.Menu) {
						for _, o := range currencyOptions {
							if m.Item(o[1]).Radio(o[0] == f.currency).Chosen() {
								f.currency = o[0]
							}
						}
					})
					ui.Column(c).Grow(1).Basis(0).Children(func() { formInput(c, k, &f.amount, amtPh) })
				})
			})
			if !credit {
				formField(c, k, tr("类别"), func() {
					formSelect(c, k, "bf-cat", tr(catalogCategoryLabel[cmpOr(f.category, "other")]), 0, func(m *ui.Menu) {
						for _, cat := range catalogCategories {
							if cat == "creditCard" {
								continue
							}
							if m.Item(tr(catalogCategoryLabel[cat])).Radio(cat == f.category).Chosen() {
								f.category = cat
							}
						}
					})
				})
				formField(c, k, tr("周期"), func() {
					opts := make([][2]string, len(cycleNames))
					for i := range cycleNames {
						opts[i] = [2]string{cycleNames[i], tr(cycleLabels[i])}
					}
					ui.Row(c).Children(func() {
						if v, ok := miniSegmented(c, k, cycleNames[f.cycle], opts); ok {
							f.cycle = slices.Index(cycleNames, v)
						}
					})
				})
				formField(c, k, tr("下次续费日"), func() {
					ui.Row(c).Children(func() { ui.DateInput(c, &f.due).FontSize(12).Label(tr("下次续费日")) })
				})
				formField(c, k, tr("开始日期（可选，自动补记开始以来的往期消费）"), func() {
					ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
						if f.start.IsZero() {
							if smallButton(c, k, "plus", tr("设置开始日期")) {
								f.start = dayStart(a.now())
							}
							return
						}
						ui.DateInput(c, &f.start).FontSize(12).Label(tr("开始日期"))
						if a.iconButton(c, k, "x", 20, 12, tr("清除开始日期")) {
							f.start = time.Time{}
						}
					})
				})
			} else {
				formField(c, k, tr("每月还款日"), func() {
					ui.Row(c).Gap(6).AlignItems(ui.Center).Children(func() {
						ui.Column(c).Width(56).Children(func() { formInput(c, k, &f.repayDay, "10").Label(tr("每月还款日（1-31）")) })
						text(c, tr("日（短月自动顺延到月末）"), 11, 16, 400, k.muted)
					})
				})
			}
			formField(c, k, tr("到期提醒"), func() {
				ui.Row(c).Wrap().Gap(4).Children(func() {
					for _, d := range billOffsetOptions {
						l := fmt.Sprintf(tr("提前 %d 天"), d)
						if d == 0 {
							l = tr("当天")
						}
						on := slices.Contains(f.remind, d)
						if pill(c, k, s, "bo-"+itoa(d), l, on) {
							if on {
								f.remind = slices.DeleteFunc(f.remind, func(x int) bool { return x == d })
							} else {
								f.remind = append(f.remind, d)
							}
						}
					}
				})
			})
			formField(c, k, tr("支付方式（可选）"), func() {
				formInput(c, k, &f.method, tr("如 支付宝 / 微信 / 招行卡尾号 1234"))
				if pms := a.usedPayMethods(); len(pms) > 0 {
					ui.Row(c).Wrap().Gap(4).Children(func() {
						for _, m := range pms {
							on := strings.TrimSpace(f.method) == m
							if pill(c, k, s, "pm-"+m, m, on) {
								if on {
									f.method = ""
								} else {
									f.method = m
								}
							}
						}
					})
				}
			})
			formField(c, k, tr("备注（可选）"), func() { formInput(c, k, &f.note, "") })
		})
	})
	label := tr("添加")
	if f.id != "" {
		label = tr("保存修改")
	}
	ui.Column(c).Padding(8, 2, 2, 2).BorderWidth(1, 0, 0, 0).BorderColor(k.inputBorder).Children(func() {
		if wideButton(c, s, "", label) {
			a.saveBillForm()
		}
	})
}

// saveBillForm 同 Tauri submit：校验 → 新建（带目录 id、开始日期补记往期）或更新。
func (a *app) saveBillForm() {
	f := &a.billForm
	now := a.now()
	name := strings.TrimSpace(f.name)
	if name == "" {
		a.showHUD("warn", tr("请填写名称"))
		return
	}
	amount := 0.0
	if v := strings.TrimSpace(f.amount); v != "" {
		x, err := strconv.ParseFloat(v, 64)
		if err != nil || x < 0 {
			a.showHUD("warn", tr("金额无效"))
			return
		}
		amount = x
	} else if f.kind == 0 {
		a.showHUD("warn", tr("订阅需要填写每期金额"))
		return
	}
	b := f.created
	b.Name, b.Amount, b.Currency, b.PayMethod, b.Note = name, amount, f.currency, strings.TrimSpace(f.method), strings.TrimSpace(f.note)
	b.RemindDays = slices.Clone(f.remind)
	if b.RemindDays == nil {
		b.RemindDays = []int{}
	}
	if f.kind == 1 {
		day, err := strconv.Atoi(strings.TrimSpace(f.repayDay))
		if err != nil || day < 1 || day > 31 {
			a.showHUD("warn", tr("还款日需为 1-31"))
			return
		}
		b.Kind, b.Cycle, b.NextDueAt, b.Category, b.StartedAt = "creditCard", "monthly", nextMonthlyDue(day, now), "", time.Time{}
	} else {
		if f.due.IsZero() {
			a.showHUD("warn", tr("请选择下次续费日期"))
			return
		}
		b.Kind, b.Cycle, b.NextDueAt, b.Category, b.StartedAt = "subscription", cycleNames[f.cycle], dayStart(f.due), f.category, f.start
		if !b.StartedAt.IsZero() {
			b.StartedAt = dayStart(b.StartedAt)
		}
	}
	if f.id == "" {
		b.CatalogID, b.CreatedAt = f.catalog, now
		a.store.AddBill(b)
		a.showHUD("added", fmt.Sprintf(tr("已添加「%s」"), name))
	} else {
		_ = a.store.UpdateBill(b)
		a.showHUD("ok", fmt.Sprintf(tr("已更新「%s」"), name))
	}
	*f = billForm{}
	a.reload()
}

// billLogo：品牌图（App Store artwork 自带约 19% 圆角，按边长 20% 裁）→ 首字色块（同 Tauri billAvatar）。
func billLogo(c *ui.Context, catalogID, name string, size float32) {
	if img := brandIcon(catalogID); img != nil {
		ui.Image(c, img).Size(size, size).Radius(size * 0.2)
		return
	}
	fs, lh := float32(11), float32(16)
	switch {
	case size >= 30:
		fs, lh = 14, 20
	case size < 20:
		fs, lh = 10, 14
	}
	initial := "?"
	if r := []rune(strings.TrimSpace(name)); len(r) > 0 {
		initial = strings.ToUpper(string(r[0]))
	}
	ui.Box(c).Size(size, size).Radius(size * 0.2).Background(billFallbackColor(name)).Center().Children(func() {
		text(c, initial, fs, lh, 600, ui.RGB(255, 255, 255))
	})
}
