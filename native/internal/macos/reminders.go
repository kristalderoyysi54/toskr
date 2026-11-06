//go:build darwin

package macos

import (
	"errors"
	"math"
	"sort"
	"time"
	"unsafe"

	"github.com/ebitengine/purego/objc"
)

// 「提醒事项」读写（同 Tauri apple_reminders.rs imp）：列表按 id → 标题找，没有就在默认账户下新建；
// 拉取走 fetchRemindersMatchingPredicate:completion:（异步回调，在回调里读成纯数据）；写入批量 save 后一次 commit。
// 需要 Info.plist 的 NSRemindersFullAccessUsageDescription（macOS 14+）/ NSRemindersUsageDescription。

const entityReminder = 1

// Reminder 是一条提醒的纯数据；H / Mi 为 -1 表示只有日期。
type Reminder struct {
	ItemID, URL, Title, Notes string
	HasDue                    bool
	Y, M, D, H, Mi            int
	Priority                  int
	Completed                 bool
	Alarms                    []int64 // 相对到期的秒数（升序）；绝对时刻的响铃记为 math.MinInt64
}

// ReminderOp 是一条写操作：create（新建并写 URL）/ update / adopt（补写 URL 再按 Want 覆盖）/ delete。
type ReminderOp struct {
	Kind, ItemID, URL string
	Want              Reminder
}

// RemindersStatus：notDetermined / restricted / denied / granted / writeOnly。
func RemindersStatus() string {
	if eventStore() == 0 {
		return "denied"
	}
	return statusName(objc.Send[int](class("EKEventStore"), sel("authorizationStatusForEntityType:"), entityReminder))
}

// RequestRemindersAccess 弹系统授权框（已决定过直接回调），等用户选择后返回新状态。
func RequestRemindersAccess() string {
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
		if objc.Send[bool](st, sel("respondsToSelector:"), sel("requestFullAccessToRemindersWithCompletion:")) {
			st.Send(sel("requestFullAccessToRemindersWithCompletion:"), block)
		} else {
			st.Send(sel("requestAccessToEntityType:completion:"), entityReminder, block)
		}
	})
	ekMu.Unlock()
	select {
	case <-done:
	case <-time.After(10 * time.Minute):
	}
	ekMu.Lock()
	withPool(func() { st.Send(sel("reset")) })
	ekMu.Unlock()
	return RemindersStatus()
}

func nsErr(e objc.ID) error {
	if e == 0 {
		return errors.New("EventKit 操作失败")
	}
	return errors.New(str(e, "localizedDescription"))
}

// ensureList：按 id 找可写列表，找不到按标题找，再没有就在默认提醒账户下新建。调用方持 ekMu、在 pool 里。
func ensureList(st objc.ID, listID, title string) (objc.ID, error) {
	if listID != "" {
		if cal := st.Send(sel("calendarWithIdentifier:"), nsString(listID)); cal != 0 && objc.Send[bool](cal, sel("allowsContentModifications")) {
			return cal, nil
		}
	}
	arr := st.Send(sel("calendarsForEntityType:"), entityReminder)
	for i := range objc.Send[uint](arr, sel("count")) {
		cal := arr.Send(sel("objectAtIndex:"), i)
		if str(cal, "title") == title && objc.Send[bool](cal, sel("allowsContentModifications")) {
			return cal, nil
		}
	}
	def := st.Send(sel("defaultCalendarForNewReminders"))
	if def == 0 || def.Send(sel("source")) == 0 {
		return 0, errors.New("找不到可写的提醒事项账户")
	}
	cal := class("EKCalendar").Send(sel("calendarForEntityType:eventStore:"), entityReminder, st)
	cal.Send(sel("setTitle:"), nsString(title))
	cal.Send(sel("setSource:"), def.Send(sel("source")))
	var e objc.ID
	if !objc.Send[bool](st, sel("saveCalendar:commit:error:"), cal, true, unsafe.Pointer(&e)) {
		return 0, nsErr(e)
	}
	return cal, nil
}

func readReminder(r objc.ID) Reminder {
	it := Reminder{ItemID: str(r, "calendarItemIdentifier"), Title: str(r, "title"), Notes: str(r, "notes"),
		Priority: int(objc.Send[uint](r, sel("priority"))), Completed: objc.Send[bool](r, sel("isCompleted"))}
	if u := r.Send(sel("URL")); u != 0 {
		it.URL = str(u, "absoluteString")
	}
	if c := r.Send(sel("dueDateComponents")); c != 0 {
		const undefined = math.MaxInt64 // NSDateComponentUndefined
		get := func(s string) int { return objc.Send[int](c, sel(s)) }
		y, m, d := get("year"), get("month"), get("day")
		if y != undefined && m != undefined && d != undefined {
			it.HasDue, it.Y, it.M, it.D, it.H, it.Mi = true, y, m, d, get("hour"), get("minute")
			if it.H == undefined {
				it.H = -1
			}
			if it.Mi == undefined {
				it.Mi = -1
			}
		}
	}
	if arr := r.Send(sel("alarms")); arr != 0 {
		for i := range objc.Send[uint](arr, sel("count")) {
			a := arr.Send(sel("objectAtIndex:"), i)
			if a.Send(sel("absoluteDate")) != 0 {
				it.Alarms = append(it.Alarms, math.MinInt64)
			} else {
				it.Alarms = append(it.Alarms, int64(math.Round(objc.Send[float64](a, sel("relativeOffset")))))
			}
		}
		sort.Slice(it.Alarms, func(i, j int) bool { return it.Alarms[i] < it.Alarms[j] })
	}
	return it
}

func applyReminder(r objc.ID, w Reminder) {
	r.Send(sel("setTitle:"), nsString(w.Title))
	if w.Notes != "" {
		r.Send(sel("setNotes:"), nsString(w.Notes))
	} else {
		r.Send(sel("setNotes:"), objc.ID(0))
	}
	if w.HasDue {
		c := class("NSDateComponents").Send(sel("new")).Send(sel("autorelease"))
		c.Send(sel("setYear:"), w.Y)
		c.Send(sel("setMonth:"), w.M)
		c.Send(sel("setDay:"), w.D)
		c.Send(sel("setHour:"), w.H)
		c.Send(sel("setMinute:"), w.Mi)
		r.Send(sel("setDueDateComponents:"), c)
	} else {
		r.Send(sel("setDueDateComponents:"), objc.ID(0))
	}
	r.Send(sel("setPriority:"), uint(w.Priority))
	if len(w.Alarms) == 0 || !w.HasDue {
		r.Send(sel("setAlarms:"), objc.ID(0))
	} else {
		arr := class("NSMutableArray").Send(sel("array"))
		for _, off := range w.Alarms {
			arr.Send(sel("addObject:"), class("EKAlarm").Send(sel("alarmWithRelativeOffset:"), float64(off)))
		}
		r.Send(sel("setAlarms:"), arr)
	}
	if objc.Send[bool](r, sel("isCompleted")) != w.Completed {
		r.Send(sel("setCompleted:"), w.Completed)
	}
}

// FetchReminders 确保列表存在并读出全部提醒，返回列表 id。
func FetchReminders(listID, title string) (string, []Reminder, error) {
	if RemindersStatus() != "granted" {
		return "", nil, errors.New("未获得提醒事项权限")
	}
	st := eventStore()
	out := make(chan []Reminder, 1)
	block := objc.NewBlock(func(_ objc.Block, arr objc.ID) {
		var items []Reminder
		withPool(func() {
			if arr != 0 {
				for i := range objc.Send[uint](arr, sel("count")) {
					items = append(items, readReminder(arr.Send(sel("objectAtIndex:"), i)))
				}
			}
		})
		select {
		case out <- items:
		default:
		}
	})
	defer block.Release()
	var id string
	var err error
	ekMu.Lock()
	withPool(func() {
		var cal objc.ID
		if cal, err = ensureList(st, listID, title); err != nil {
			return
		}
		id = str(cal, "calendarIdentifier")
		cals := class("NSArray").Send(sel("arrayWithObject:"), cal)
		pred := st.Send(sel("predicateForRemindersInCalendars:"), cals)
		st.Send(sel("fetchRemindersMatchingPredicate:completion:"), pred, block)
	})
	ekMu.Unlock()
	if err != nil {
		return "", nil, err
	}
	select {
	case items := <-out:
		return id, items, nil
	case <-time.After(30 * time.Second):
		return id, nil, errors.New("读取提醒事项超时")
	}
}

// WriteReminders 在列表里批量执行写操作，最后一次 commit。
func WriteReminders(listID string, ops []ReminderOp) error {
	if len(ops) == 0 {
		return nil
	}
	st := eventStore()
	var err error
	ekMu.Lock()
	defer ekMu.Unlock()
	withPool(func() {
		list := st.Send(sel("calendarWithIdentifier:"), nsString(listID))
		if list == 0 {
			err = errors.New("提醒列表不见了")
			return
		}
		find := func(itemID string) objc.ID {
			it := st.Send(sel("calendarItemWithIdentifier:"), nsString(itemID))
			if it == 0 || !objc.Send[bool](it, sel("isKindOfClass:"), class("EKReminder")) {
				return 0
			}
			return it
		}
		var e objc.ID
		for _, op := range ops {
			var r objc.ID
			switch op.Kind {
			case "create":
				r = class("EKReminder").Send(sel("reminderWithEventStore:"), st)
				r.Send(sel("setCalendar:"), list)
			case "update", "adopt", "delete":
				if r = find(op.ItemID); r == 0 {
					continue
				}
			}
			if op.Kind == "delete" {
				if !objc.Send[bool](st, sel("removeReminder:commit:error:"), r, false, unsafe.Pointer(&e)) {
					err = nsErr(e)
					return
				}
				continue
			}
			if op.URL != "" {
				r.Send(sel("setURL:"), class("NSURL").Send(sel("URLWithString:"), nsString(op.URL)))
			}
			applyReminder(r, op.Want)
			if !objc.Send[bool](st, sel("saveReminder:commit:error:"), r, false, unsafe.Pointer(&e)) {
				err = nsErr(e)
				return
			}
		}
		if !objc.Send[bool](st, sel("commit:"), unsafe.Pointer(&e)) {
			err = nsErr(e)
		}
	})
	return err
}

var ekObserver objc.Block

// OnEventStoreChanged 订阅 EKEventStoreChangedNotification（提醒事项 / 日历在别处被改），回调在任意线程。
func OnEventStoreChanged(fn func()) {
	st := eventStore()
	if st == 0 || ekObserver != 0 {
		return
	}
	ekObserver = objc.NewBlock(func(_ objc.Block, _ objc.ID) { fn() }) // 常驻，不释放
	withPool(func() {
		center := class("NSNotificationCenter").Send(sel("defaultCenter"))
		center.Send(sel("addObserverForName:object:queue:usingBlock:"), nsString("EKEventStoreChangedNotification"), st, objc.ID(0), ekObserver)
	})
}
