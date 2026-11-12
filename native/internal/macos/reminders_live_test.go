//go:build darwin

package macos

import (
	"os"
	"testing"
)

// TOSKR_LIVE_EK=1 时真机读取提醒事项授权状态；已授权才继续拉取（不建列表以外的东西，不弹授权框）。
func TestRemindersLive(t *testing.T) {
	if os.Getenv("TOSKR_LIVE_EK") == "" {
		t.Skip("真机检查：TOSKR_LIVE_EK=1")
	}
	st := RemindersStatus()
	t.Logf("提醒事项授权状态：%s", st)
	if st != "granted" {
		return
	}
	id, items, err := FetchReminders("", "Toskr Native")
	t.Logf("列表 %s · %d 条 · err=%v", id, len(items), err)
}
