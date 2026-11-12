package main

import (
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/egoist/mygo/ui"

	"github.com/toskr/native/internal/diag"
	"github.com/toskr/native/internal/secretcodec"
	"github.com/toskr/native/internal/store"
)

// 「内容 → 秘文」按 Tauri SecretPage 复刻：顶部收发条（选密钥 / 选格式 → 输明文 → 加密复制 / 加密发送），
// 下方卡片默认虚化遮罩、点击解密显现，超时 / 面板隐藏自动回遮罩。明文只在内存（secretPlain），不落盘。
// 密文格式由 internal/secretcodec 提供，与 Tauri 版互通（双向向量验证见其测试）。

func (a *app) secretsPage(c *ui.Context, k tokens) {
	st := a.store.Settings()
	if a.hbar() { // 横栏（同 Tauri SecretPage horizontal）：输入区收作左列，卡片改横排瓷砖串
		ui.Row(c).Grow(1).Basis(0).AlignItems(ui.Stretch).Children(func() {
			ui.Scroll(c).Width(320).Scrollbars(false).Children(func() { a.secretComposer(c, k, st) })
			empty := tr("还没有秘文——选中对方发来的密文内容，连按两次 ⇧ Shift 即可解密到这里")
			if a.query != "" {
				empty = tr("没有匹配的秘文")
			}
			a.strip(c, k, "strip-secret", &a.bar.secret, len(a.secrets), -1, nil, "", empty, func(i int, h float32) {
				ui.Scroll(c).Width(h*16/17).FillHeight().Scrollbars(false).Key("sectile-" + a.secrets[i].ID).Children(func() {
					a.secretCard(c, k, st, a.secrets[i])
				})
			})
		})
		if len(a.revealed) > 0 {
			c.AnimationFrame()
		}
		return
	}
	a.secretComposer(c, k, st)
	ui.Scroll(c).Grow(1).Scrollbars(false).Children(func() {
		ui.Column(c).Padding(10, 12).Gap(8).Children(func() {
			if len(a.secrets) == 0 {
				key := modifierLabels[max(0, slices.Index(modifierNames, st.TriggerModifier))]
				a.emptyState(c, k, "lock", tr("还没有秘文"), fmt.Sprintf(tr("选中对方发来的密文内容，连按两次 %s 即可解密到这里"), key))
				return
			}
			for _, s := range a.secrets {
				a.secretCard(c, k, st, s)
			}
		})
	})
	if len(a.revealed) > 0 {
		c.AnimationFrame() // 燃尽条匀速走、到时回遮罩
	}
}

func (a *app) secretComposer(c *ui.Context, k tokens, st store.Settings) {
	s := stok(c)
	box := ui.Column(c).Padding(10, 12).Gap(8).BorderWidth(0, 0, 1, 0).BorderColor(s.asideBorder)
	if len(st.SecretKeys) == 0 {
		box.Children(func() {
			text(c, tr("还没有共享密钥。去 设置 → 秘文 添加一组、与对方约定相同的暗号即可开始收发。"), 11, 16, 400, k.muted).Wrap()
		})
		return
	}
	if !slices.ContainsFunc(st.SecretKeys, func(x store.SecretKey) bool { return x.ID == a.secretKeyID }) {
		a.secretKeyID = st.SecretDefaultKeyID
		if !slices.ContainsFunc(st.SecretKeys, func(x store.SecretKey) bool { return x.ID == a.secretKeyID }) {
			a.secretKeyID = st.SecretKeys[0].ID
		}
	}
	style := secretcodec.NormalizeStyle(st.SecretCipherStyle)
	draft := strings.TrimSpace(a.secretDraft)
	tooLong := draft != "" && !secretcodec.LengthSupported(draft, style)
	box.Children(func() {
		ui.Row(c).Gap(6).Children(func() {
			label := ""
			for _, key := range st.SecretKeys {
				if key.ID == a.secretKeyID {
					label = cmpOr(key.Label, tr("未命名密钥"))
				}
			}
			tipOf(c, selectBox(c, k, s, "key-round", label, 0, func(m *ui.Menu) {
				for _, key := range st.SecretKeys {
					if m.Item(cmpOr(key.Label, tr("未命名密钥"))).Radio(key.ID == a.secretKeyID).Chosen() {
						a.secretKeyID = key.ID
					}
				}
			}), tr("用哪把密钥"))
			short := ""
			for _, o := range secretcodec.StyleOptions {
				if o.Value == style {
					short = tr(o.ShortLabel)
				}
			}
			tipOf(c, selectBox(c, k, s, "braces", short, 96, func(m *ui.Menu) {
				for _, o := range secretcodec.StyleOptions {
					if m.Item(tr(o.Label)).Radio(o.Value == style).Chosen() {
						cur := a.store.Settings()
						cur.SecretCipherStyle = string(o.Value)
						_ = a.store.SetSettings(cur)
					}
				}
			}), tr("密文格式 · 支持该格式的接收端自动识别"))
		})
		ui.Column(c).Padding(8, 10).Gap(6).Radius(rr(10)).Border(1, s.inputBorder).Children(func() {
			ui.TextAreaBase(c, &a.secretDraft).FillWidth().Lines(2, 6).Font(fontSans).FontSize(12).FixedLineHeight(17).
				TextColor(k.fg).PlaceholderColor(k.muted).Placeholder(tr("写下要加密的话，⌘⏎ 加密并发送")).
				OnTextKey(func(key ui.TextKey) bool {
					if key.Key == ui.KeyEnter && key.Mods == ui.Cmd {
						a.secretDraft = key.Text()
						a.sealSecret(c, true)
						key.SetText(a.secretDraft)
						return true
					}
					return false
				})
			ui.Row(c).Height(28).Gap(8).AlignItems(ui.Center).Children(func() {
				hint := ""
				if draft != "" {
					hint = fmt.Sprintf(tr("输出约 %d 字 · %s"), secretcodec.EstimateLength(draft, style), styleLabel(style))
					if tooLong {
						hint = tr("内容过长，无法生成可接收的秘文")
					}
				}
				text(c, hint, 10, 14, 400, k.muted).SingleLine().Grow(1)
				disabled := draft == "" || tooLong || a.secretBusy
				if actionButton(c, k, s, "copy", tr("加密复制"), false, disabled) {
					a.sealSecret(c, false)
				}
				if actionButton(c, k, s, "send-horizontal", tr("加密发送"), true, disabled) {
					a.sealSecret(c, true)
				}
			})
		})
	})
}

func styleLabel(style secretcodec.Style) string {
	for _, o := range secretcodec.StyleOptions {
		if o.Value == style {
			return tr(o.Label)
		}
	}
	return ""
}

// sealSecret 加密草稿：收进「我发出」卡片，再走发送链路（含目标核验）或复制到剪贴板。
func (a *app) sealSecret(c *ui.Context, send bool) {
	st := a.store.Settings()
	text := strings.TrimSpace(a.secretDraft)
	i := slices.IndexFunc(st.SecretKeys, func(x store.SecretKey) bool { return x.ID == a.secretKeyID })
	if i < 0 || text == "" || a.secretBusy {
		return
	}
	style := secretcodec.NormalizeStyle(st.SecretCipherStyle)
	if !secretcodec.LengthSupported(text, style) {
		a.showHUD("warn", tr("内容过长，无法生成可接收的秘文"))
		return
	}
	key := st.SecretKeys[i]
	a.secretBusy = true
	go func() {
		cipher, err := secretcodec.Seal(text, key.Passphrase, style)
		a.panelUpdate(func() {
			a.secretBusy = false
			if err != nil {
				a.showHUD("warn", tr("加密失败，请重试"))
				return
			}
			sec, _ := a.store.AddSecret(store.Secret{Text: cipher, KeyID: key.ID, KeyLabel: key.Label, Direction: "out"})
			a.secretDraft = ""
			a.reload()
			if send {
				a.send([]store.Note{{ID: sec.ID, Text: cipher}})
				return
			}
			a.copyPrivate(cipher)
			a.showHUD("ok", tr("已加密并复制，去 IM 粘贴即可"))
		})
	}()
}

// panelUpdate 把后台结果交回主线程；无窗口的视图测试里排进队列，由下一帧 drainUpdates 执行。
func (a *app) panelUpdate(fn func()) {
	if a.panel != nil {
		a.panel.Update(fn)
		return
	}
	a.updMu.Lock()
	a.updQueue = append(a.updQueue, fn)
	a.updMu.Unlock()
}

func (a *app) drainUpdates() {
	a.updMu.Lock()
	q := a.updQueue
	a.updQueue = nil
	a.updMu.Unlock()
	for _, fn := range q {
		fn()
	}
}

func (a *app) secretCard(c *ui.Context, k tokens, st store.Settings, sec store.Secret) {
	s := stok(c)
	plain, revealed := a.secretPlain[sec.ID]
	if revealed && st.SecretRevealMs > 0 && time.Now().After(a.revealed[sec.ID]) {
		a.remask(sec.ID)
		revealed = false
	}
	bg, border := gray(1, 1), gray(0.922, 0.7)
	if k.dark {
		bg, border = gray(0.205, 1), gray(1, 0.07)
	}
	ui.Column(c).Radius(rr(10)).Background(bg).Border(1, border).Key("sec-" + sec.ID).Children(func() {
		ui.Row(c).Padding(8, 12, 0, 12).Gap(6).AlignItems(ui.Center).Children(func() {
			icon, dir := "shield-check", tr("收到")
			if sec.Direction == "out" {
				icon, dir = "send-horizontal", tr("我发出")
			}
			licon(c, icon, 12, k.muted)
			label := sec.KeyLabel
			if label == "" {
				label = tr("未匹配密钥")
				if sec.KeyID != "" {
					label = tr("已解密")
				}
			}
			text(c, label, 10, 14, 500, k.muted)
			text(c, "·", 10, 14, 400, k.muted)
			text(c, dir, 10, 14, 400, k.muted)
			ui.Spacer(c)
			text(c, ago(sec.CreatedAt, a.now()), 10, 14, 400, k.muted)
		})
		body := tipOf(c, ui.Column(c).Padding(8, 12), tr("点击解密查看"))
		// AnimatePresence mode="wait"：解密时遮罩先淡出（120ms ease-standard），明文再淡入并去模糊（opacity 0 → 1、blur 6 → 0，300ms ease-standard）；
		// 回遮罩时遮罩淡入（120ms easeInOut）。明文在回遮罩那一刻即从内存丢弃，不再播它的淡出。
		maskOp, plainOp, plainBlur := float32(1), float32(1), float32(0)
		if revealed {
			ms := a.secretFxMs(c, "r:"+sec.ID)
			if ms < 120 {
				revealed, maskOp = false, 1-easeStandard(ms/120)
			} else {
				e := easeStandard(min((ms-120)/300, 1))
				plainOp, plainBlur = e, 6*(1-e)
			}
		} else if _, ok := a.secretFx["m:"+sec.ID]; ok {
			maskOp = easeMInOut(min(a.secretFxMs(c, "m:"+sec.ID)/120, 1))
		}
		body.Children(func() {
			if revealed {
				ui.Row(c).Gap(8).AlignItems(ui.Start).Opacity(plainOp).Blur(plainBlur).Children(func() {
					licon(c, "lock-open", 14, k.muted).Margin(2, 0, 0, 0)
					text(c, plain, 12, 17, 400, k.fg).Wrap().Selectable().Grow(1).Basis(0)
				})
				return
			}
			ui.Column(c).Padding(2, 0).Opacity(maskOp).Children(func() {
				r := []rune(sec.Text)
				preview := strings.Join(strings.Fields(string(r[:min(72, len(r))])), " ") // 同 CSS 空白折叠：换行显示为空格
				text(c, preview, 12, 19.5, 400, k.muted.Alpha(0.8)).Wrap().MaxLines(2).Blur(4)
				ui.Box(c).Absolute().Top(0).Left(0).Right(0).Bottom(0).Center().Children(func() {
					ui.Row(c).Height(26).Padding(4, 10).Gap(6).Radius(13).Background(k.floatBtn.Alpha(0.95)).Border(1, k.floatBorder).
						Shadow(0, 1, 2, 0, k.floatShadowA).Shadow(0, 6, 16, -4, k.floatShadowB).InsetShadow(0, 1, 0, 0, k.floatInset).
						AlignItems(ui.Center).Children(func() {
						switch {
						case a.secretOpening[sec.ID]: // animate-pulse：opacity 1 → 0.5 → 1，2s cubic-bezier(0.4,0,0.6,1)
							busy := text(c, tr("解密中…"), 11, 16, 400, k.muted)
							if !c.Preferences().ReduceMotion {
								busy.Opacity(1 - 0.5*busy.Loop("pulse", 2*time.Second, ui.Bounce(easePulse)))
							}
						case sec.KeyID == "":
							licon(c, "key-round", 12, k.muted)
							text(c, tr("无匹配密钥 · 点击重试"), 11, 16, 400, k.muted)
						default:
							licon(c, "lock", 12, k.muted)
							text(c, tr("点击解密查看"), 11, 16, 400, k.muted)
						}
					})
				})
			})
		})
		if body.Clicked() {
			if revealed {
				a.remask(sec.ID)
			} else {
				a.openSecretCard(sec, st)
			}
		}
		if revealed && st.SecretRevealMs > 0 {
			left := float32(time.Until(a.revealed[sec.ID])) / float32(time.Duration(st.SecretRevealMs)*time.Millisecond)
			ui.Box(c).Height(2).Margin(0, 12).Radius(1).Background(s.inputBorder.Alpha(0.4)).Children(func() {
				ui.Box(c).Absolute().Left(0).Top(0).Bottom(0).WidthPercent(max(0, min(1, left)) * 100).Radius(1).Background(k.amberBar)
			})
		}
		ui.Row(c).Padding(2, 8, 6, 8).Gap(4).Justify(ui.End).Children(func() {
			if revealed {
				if a.iconButton(c, k, "eye-off", 20, 12, tr("重新遮罩")) {
					a.remask(sec.ID)
				}
				if a.iconButton(c, k, "copy", 20, 12, tr("复制明文")) {
					a.copyPrivate(plain)
					a.showHUD("ok", tr("已复制明文"))
				}
			}
			if a.iconButton(c, k, "trash-2", 20, 12, tr("删除")) {
				if removed, pos, ok := a.store.DeleteSecret(sec.ID); ok {
					a.remask(sec.ID)
					a.reload()
					a.showHUDUndo("ok", tr("已删除 1 条秘文"), func() { _ = a.store.RestoreSecret(removed, pos); a.reload() })
				}
			}
		})
	})
}

// openSecretCard 在后台逐密钥试解（PBKDF2 15 万轮，不阻塞界面），命中则显现并开始倒计时。
func (a *app) openSecretCard(sec store.Secret, st store.Settings) {
	if a.secretOpening[sec.ID] {
		return
	}
	a.secretOpening[sec.ID] = true
	keys := store.CodecKeys(st.SecretKeys)
	go func() {
		res := secretcodec.Open(sec.Text, keys)
		a.panelUpdate(func() {
			delete(a.secretOpening, sec.ID)
			if res.Status != "plaintext" {
				a.showHUD("warn", tr("无匹配密钥，去 设置 → 秘文 添加后可解密"))
				return
			}
			a.secretPlain[sec.ID] = res.Plaintext
			a.revealed[sec.ID] = time.Now().Add(time.Duration(st.SecretRevealMs) * time.Millisecond)
			if res.KeyID != sec.KeyID || res.KeyLabel != sec.KeyLabel {
				_ = a.store.SetSecretKey(sec.ID, res.KeyID, res.KeyLabel)
				a.reload()
			}
		})
	}()
}

func (a *app) remask(id string) {
	if _, ok := a.secretPlain[id]; ok {
		a.secretFx["m:"+id] = time.Time{} // 下一帧起播遮罩淡入
	}
	delete(a.secretFx, "r:"+id)
	delete(a.secretPlain, id)
	delete(a.revealed, id)
}

// secretFxMs 返回秘文卡某段过场（r: 解密显现 / m: 回遮罩）开始至今的毫秒数；首次调用记为本帧。过场 420ms 内持续要帧，之后清掉回遮罩的记录。
func (a *app) secretFxMs(c *ui.Context, key string) float32 {
	at, ok := a.secretFx[key]
	if !ok || at.IsZero() {
		at = c.Now()
		a.secretFx[key] = at
	}
	ms := float32(c.Now().Sub(at)) / float32(time.Millisecond)
	if ms < 420 {
		c.AnimationFrame()
	} else if key[0] == 'm' {
		delete(a.secretFx, key)
	}
	return ms
}

// remaskAll：面板隐藏 / 失焦时全部回遮罩，明文从内存丢弃。
func (a *app) remaskAll() {
	clear(a.secretPlain)
	clear(a.revealed)
	clear(a.secretFx)
}

// captureSecret 是双击捕获的秘文分支：识别到密文信封就逐密钥试解并收进秘文页，绝不进普通笔记。
// 在捕获协程里调用（试解耗时）；返回 false 表示不是秘文。
func (a *app) captureSecret(text, sourceApp string) bool {
	st := a.store.Settings()
	if !st.SecretEnabled || !secretcodec.IsEnvelope(text) {
		return false
	}
	res := secretcodec.Open(text, store.CodecKeys(st.SecretKeys))
	diag.Push("捕获: 秘文 status=%s", res.Status)
	a.panelUpdate(func() {
		meta := store.Secret{Text: text, Direction: "in", SourceApp: sourceApp}
		if res.Status == "plaintext" {
			meta.KeyID, meta.KeyLabel = res.KeyID, res.KeyLabel
		}
		sec, result := a.store.AddSecret(meta)
		a.reload()
		switch {
		case result == "duplicate":
			a.showHUD("duplicate", tr("这条秘文已在秘文页"))
		case res.Status != "plaintext":
			a.showHUD("warn", tr("识别到密文，但没有匹配的密钥"))
		default:
			a.secretPlain[sec.ID] = res.Plaintext // 捕获即解密：直接显现，开始倒计时
			a.revealed[sec.ID] = time.Now().Add(time.Duration(st.SecretRevealMs) * time.Millisecond)
			id := sec.ID
			a.showHUDUndo("added", fmt.Sprintf(tr("已解密 1 条 · 用【%s】"), res.KeyLabel), func() {
				a.store.DeleteSecret(id)
				a.remask(id)
				a.reload()
			})
		}
	})
	return true
}

// selectBox 是 Tauri SimpleSelect 触发钮：32 高、圆角 10、描边，图标 + 文字 + 下拉箭头，点开原生菜单。
func selectBox(c *ui.Context, k tokens, s settingsTokens, icon, label string, width float32, menu func(*ui.Menu)) ui.Element {
	b := ui.Row(c).Height(32).Padding(0, 8).Gap(4).Radius(rr(10)).Border(1, s.inputBorder).AlignItems(ui.Center)
	if width > 0 {
		b.Width(width)
	} else {
		b.Grow(1).Basis(0)
	}
	if b.Hovered() {
		b.Background(k.track)
	}
	b.Children(func() {
		licon(c, icon, 14, k.muted)
		text(c, label, 12, 17, 400, k.fg).SingleLine().Grow(1).Basis(0)
		licon(c, "chevron-down", 14, k.muted)
	})
	b.Menu(menu)
	return b
}

// actionButton 是 Tauri Button size="sm"：primary 为白底描边主键，否则 ghost；禁用时 45% 透明且不响应。
func actionButton(c *ui.Context, k tokens, s settingsTokens, icon, label string, primary, disabled bool) bool {
	b := ui.Row(c).Height(28).Padding(0, 10).Gap(6).Radius(rr(10)).AlignItems(ui.Center).Key("ab-" + label)
	fg := k.fg
	if primary {
		b.Background(s.btn).Border(1, s.btnBorder).Shadow(0, 1, 2, 0, s.btnShadow)
		fg = s.btnFg
	} else {
		b.Border(1, ui.Transparent)
		if !disabled && b.Hovered() {
			b.Background(k.track)
		}
	}
	if disabled {
		b.Opacity(0.45)
	}
	b.Children(func() {
		licon(c, icon, 14, fg)
		text(c, label, 12, 17, 500, fg)
	})
	return b.Clicked() && !disabled
}
