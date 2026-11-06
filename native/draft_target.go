package main

import "fmt"

// 冻结发送目标（同 Tauri validate_target_snapshot / ensure_token_current 的 draft-target-changed）：
// 预检条或「粘贴后按回车？」出现时记下当时的目标；真正投递前目标换了（在目标条改选、目标重启）就中止，
// 不把为 A 准备好的内容（替换方案、方案策略都按 A 定的）发给 B，也不标完成。
type draftTarget struct {
	pid     int32
	started int64
	name    string
}

func (a *app) freezeDraftTarget() {
	a.draftTarget = draftTarget{a.target.PID, a.targetStarted, a.target.Name}
}

// draftTargetChanged 在投递入口调用：冻结过且与当前目标不同 → 作废这次准备并提示，返回 true。
func (a *app) draftTargetChanged() bool {
	d := a.draftTarget
	a.draftTarget = draftTarget{}
	if d.pid == 0 || (d.pid == a.target.PID && d.started == a.targetStarted) {
		return false
	}
	a.sendMode, a.sendPNG, a.sendPH, a.lastRedactions = "", nil, sendRedaction{}, 0
	a.showHUD("warn", fmt.Sprintf(tr("目标已变化：这次内容是为 %s 准备的，未发送，请重新发送"), d.name))
	return true
}
