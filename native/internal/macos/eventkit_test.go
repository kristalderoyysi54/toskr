//go:build darwin

package macos

import (
	"slices"
	"testing"
)

// 只读状态，不请求授权（测试二进制没有 Info.plist 用途说明，请求会崩）。
func TestCalendarStatusAndURL(t *testing.T) {
	st := CalendarStatus()
	if !slices.Contains([]string{"notDetermined", "restricted", "denied", "granted", "writeOnly"}, st) {
		t.Fatalf("状态 %q", st)
	}
	if st != "granted" && (CalendarEvents(0, 1) != nil || Calendars() != nil) {
		t.Fatal("未授权应返回空")
	}
	if got := CalendarEventURL("ABC-1", 0, false); got != "ical://ekevent/ABC-1?method=show&options=more" {
		t.Fatal(got)
	}
	if got := CalendarEventURL("ABC-1", 1700000000000, true); got != "ical://ekevent/20231114T221320Z/ABC-1?method=show&options=more" {
		t.Fatal(got)
	}
	if CalendarEventURL("a b", 0, false) != "ical://" || CalendarEventURL("", 0, false) != "ical://" {
		t.Fatal("异常标识符只开日历")
	}
}
