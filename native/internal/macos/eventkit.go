//go:build darwin

package macos

import (
	"fmt"
	"math"
	"sync"
	"time"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

// 「日历」日程（同 Tauri apple_calendar.rs）：读授权状态、请求完整访问、列日历、取区间内日程。
// 需要 Info.plist 的 NSCalendarsFullAccessUsageDescription（macOS 14+）/ NSCalendarsUsageDescription，否则请求授权会崩。

// CalendarInfo 是一个日历。
type CalendarInfo struct {
	ID, Title, Source, Color string // Color 为 sRGB #rrggbb，取不到为空
}

// CalendarEvent 是一条日程（重复日程每期一条，ID 拼上开始时刻保证唯一）。
type CalendarEvent struct {
	ID, Title                                string
	StartMs, EndMs                           int64
	AllDay, Recurring                        bool
	CalendarID, CalendarTitle, CalendarColor string
	Location, ItemID                         string
}

var (
	ekOnce  sync.Once
	ekMu    sync.Mutex // EKEventStore 串行使用
	ekStore objc.ID
)

func eventStore() objc.ID {
	ekOnce.Do(func() {
		load()
		if _, err := purego.Dlopen("/System/Library/Frameworks/EventKit.framework/EventKit", purego.RTLD_NOW|purego.RTLD_GLOBAL); err != nil {
			return
		}
		withPool(func() { ekStore = class("EKEventStore").Send(sel("alloc")).Send(sel("init")) }) // 常驻进程，不释放
	})
	return ekStore
}

// CalendarStatus：notDetermined / restricted / denied / granted / writeOnly（13 的 Authorized 与 14 的 FullAccess 同值 3）。
func CalendarStatus() string {
	if eventStore() == 0 {
		return "denied"
	}
	const entityEvent = 0
	return statusName(objc.Send[int](class("EKEventStore"), sel("authorizationStatusForEntityType:"), entityEvent))
}

func statusName(raw int) string {
	switch raw {
	case 0:
		return "notDetermined"
	case 1:
		return "restricted"
	case 3:
		return "granted"
	case 4:
		return "writeOnly"
	}
	return "denied"
}

// RequestCalendarAccess 弹系统授权框（已决定过则直接回调），等用户选择后返回新状态。
func RequestCalendarAccess() string {
	st := eventStore()
	if st == 0 {
		return "denied"
	}
	done := make(chan struct{}, 1)
	block := objc.NewBlock(func(_ objc.Block, _ bool, _ objc.ID) {
		select {
		case done <- struct{}{}:
		default:
		}
	})
	defer block.Release()
	ekMu.Lock()
	withPool(func() {
		if objc.Send[bool](st, sel("respondsToSelector:"), sel("requestFullAccessToEventsWithCompletion:")) { // 14 起必须走 FullAccess（旧接口只给只写）
			st.Send(sel("requestFullAccessToEventsWithCompletion:"), block)
		} else {
			st.Send(sel("requestAccessToEntityType:completion:"), 0, block)
		}
	})
	ekMu.Unlock()
	select {
	case <-done:
	case <-time.After(10 * time.Minute):
	}
	ekMu.Lock()
	withPool(func() { st.Send(sel("reset")) }) // 授权前建的 store 看不到日历，重置后才读得到
	ekMu.Unlock()
	return CalendarStatus()
}

// Calendars 列出全部日程日历；未授权返回空。
func Calendars() []CalendarInfo {
	if CalendarStatus() != "granted" {
		return nil
	}
	var out []CalendarInfo
	ekMu.Lock()
	defer ekMu.Unlock()
	withPool(func() {
		arr := eventStore().Send(sel("calendarsForEntityType:"), 0)
		for i := range objc.Send[uint](arr, sel("count")) {
			cal := arr.Send(sel("objectAtIndex:"), i)
			info := CalendarInfo{ID: str(cal, "calendarIdentifier"), Title: str(cal, "title"), Color: hexColor(cal)}
			if src := cal.Send(sel("source")); src != 0 {
				info.Source = str(src, "title")
			}
			out = append(out, info)
		}
	})
	return out
}

// CalendarEvents 返回与 [startMs, endMs) 相交的全部日程（含跨区间的长日程）；未授权返回空。
func CalendarEvents(startMs, endMs int64) []CalendarEvent {
	if endMs <= startMs || CalendarStatus() != "granted" {
		return nil
	}
	var out []CalendarEvent
	ekMu.Lock()
	defer ekMu.Unlock()
	withPool(func() {
		st := eventStore()
		date := func(ms int64) objc.ID {
			return class("NSDate").Send(sel("dateWithTimeIntervalSince1970:"), float64(ms)/1000)
		}
		msOf := func(d objc.ID) int64 {
			return int64(math.Round(objc.Send[float64](d, sel("timeIntervalSince1970")) * 1000))
		}
		pred := st.Send(sel("predicateForEventsWithStartDate:endDate:calendars:"), date(startMs), date(endMs), objc.ID(0))
		arr := st.Send(sel("eventsMatchingPredicate:"), pred)
		for i := range objc.Send[uint](arr, sel("count")) {
			ev := arr.Send(sel("objectAtIndex:"), i)
			start := msOf(ev.Send(sel("startDate")))
			e := CalendarEvent{
				ID: fmt.Sprintf("%s@%d", str(ev, "eventIdentifier"), start), Title: str(ev, "title"),
				StartMs: start, EndMs: msOf(ev.Send(sel("endDate"))),
				AllDay: objc.Send[bool](ev, sel("isAllDay")), Recurring: objc.Send[bool](ev, sel("hasRecurrenceRules")),
				Location: str(ev, "location"), ItemID: str(ev, "calendarItemIdentifier"),
			}
			if cal := ev.Send(sel("calendar")); cal != 0 {
				e.CalendarID, e.CalendarTitle, e.CalendarColor = str(cal, "calendarIdentifier"), str(cal, "title"), hexColor(cal)
			}
			out = append(out, e)
		}
	})
	return out
}

func str(o objc.ID, getter string) string { return goString(uintptr(o.Send(sel(getter)))) }

func hexColor(cal objc.ID) string {
	col := cal.Send(sel("color"))
	if col == 0 {
		return ""
	}
	rgb := col.Send(sel("colorUsingColorSpace:"), class("NSColorSpace").Send(sel("sRGBColorSpace")))
	if rgb == 0 {
		return ""
	}
	b := func(s string) int {
		return int(math.Round(math.Max(0, math.Min(1, objc.Send[float64](rgb, sel(s)))) * 255))
	}
	return fmt.Sprintf("#%02x%02x%02x", b("redComponent"), b("greenComponent"), b("blueComponent"))
}

// CalendarEventURL：在「日历」App 里定位这条日程；重复日程要带这一期的开始时刻（UTC），标识符异常时只打开「日历」。
func CalendarEventURL(itemID string, startMs int64, recurring bool) string {
	if itemID == "" {
		return "ical://"
	}
	for _, c := range itemID {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_' || c == ':' || c == '.' || c == '@') {
			return "ical://"
		}
	}
	if recurring {
		return "ical://ekevent/" + time.UnixMilli(startMs).UTC().Format("20060102T150405Z") + "/" + itemID + "?method=show&options=more"
	}
	return "ical://ekevent/" + itemID + "?method=show&options=more"
}
