//go:build darwin

package macos

import (
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
)

var (
	procOnce    sync.Once
	procPidinfo func(pid int32, flavor int32, arg uint64, buf unsafe.Pointer, size int32) int32
)

// ProcessStartMs 是内核记录的进程启动时刻（proc_bsdinfo.pbi_start_tvsec/usec，偏移 120/128）。
// pid 被复用时该值必然不同，用于目标身份锁定。取不到返回 0。
func ProcessStartMs(pid int32) int64 {
	procOnce.Do(func() {
		lib, err := purego.Dlopen("/usr/lib/libproc.dylib", purego.RTLD_NOW)
		if err == nil {
			purego.RegisterLibFunc(&procPidinfo, lib, "proc_pidinfo")
		}
	})
	if procPidinfo == nil {
		return 0
	}
	var buf [136]byte
	if procPidinfo(pid, 3, 0, unsafe.Pointer(&buf[0]), int32(len(buf))) != int32(len(buf)) {
		return 0
	}
	le := func(b []byte) int64 {
		var v int64
		for i := 7; i >= 0; i-- {
			v = v<<8 | int64(b[i])
		}
		return v
	}
	return le(buf[120:128])*1000 + le(buf[128:136])/1000
}
