package main

func init() { targetAlive = func(int32, int64) bool { return true } } // 测试里的目标 PID 是假的

// submitPending：测试里模拟在预检条上按 ⌘⏎ 提交（同 Tauri smart 预检：多卡、模板、代码 / 去 Markdown、确认回车都先进预检）。
func submitPending(a *app) {
	if len(a.pending) > 0 {
		a.pfSubmit()
	}
}
