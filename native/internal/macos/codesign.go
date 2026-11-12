//go:build darwin

package macos

import (
	"errors"
	"fmt"
	"runtime"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
)

var (
	secOnce                        sync.Once
	secErr                         error
	secCodeCopyGuestWithAttributes func(host, attrs uintptr, flags uint32, code *uintptr) int32
	secRequirementCreateWithString func(text uintptr, flags uint32, req *uintptr) int32
	secCodeCheckValidity           func(code uintptr, flags uint32, req uintptr) int32
	cfDataCreate                   func(alloc uintptr, b *byte, n int) uintptr
	kSecGuestAttributeAudit        uintptr
)

func loadSecurity() error {
	secOnce.Do(func() {
		load()
		lib, err := purego.Dlopen("/System/Library/Frameworks/Security.framework/Security", purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			secErr = err
			return
		}
		purego.RegisterLibFunc(&secCodeCopyGuestWithAttributes, lib, "SecCodeCopyGuestWithAttributes")
		purego.RegisterLibFunc(&secRequirementCreateWithString, lib, "SecRequirementCreateWithString")
		purego.RegisterLibFunc(&secCodeCheckValidity, lib, "SecCodeCheckValidity")
		purego.RegisterLibFunc(&cfDataCreate, cf, "CFDataCreate")
		kSecGuestAttributeAudit = deref(lib, "kSecGuestAttributeAudit")
	})
	return secErr
}

// CheckAuditToken 校验 audit token 指向的进程满足代码签名要求 requirement（内核给的对端身份，不受 PID 复用影响）。
func CheckAuditToken(token []byte, requirement string) error {
	if len(token) != 32 {
		return errors.New("audit token 长度不对")
	}
	if err := loadSecurity(); err != nil {
		return err
	}
	data := cfDataCreate(0, &token[0], len(token))
	runtime.KeepAlive(token)
	if data == 0 {
		return errors.New("CFDataCreate 失败")
	}
	defer CFRelease(data)
	key := kSecGuestAttributeAudit
	attrs := CFDictionaryCreate(0, &key, &data, 1, kCFTypeDictionaryKeyCallBacks, kCFTypeDictionaryValueCallBacks)
	if attrs == 0 {
		return errors.New("CFDictionaryCreate 失败")
	}
	defer CFRelease(attrs)
	var code, req uintptr
	if st := secCodeCopyGuestWithAttributes(0, attrs, 0, &code); st != 0 {
		return fmt.Errorf("SecCodeCopyGuestWithAttributes: %d", st)
	}
	defer CFRelease(code)
	text := cfString(requirement)
	defer CFRelease(text)
	if st := secRequirementCreateWithString(text, 0, &req); st != 0 {
		return fmt.Errorf("SecRequirementCreateWithString: %d", st)
	}
	defer CFRelease(req)
	if st := secCodeCheckValidity(code, 0, req); st != 0 {
		return fmt.Errorf("对端签名不符合要求: %d", st)
	}
	return nil
}

// PeerAuditToken 读 Unix 域 socket 对端的 audit token（getsockopt SOL_LOCAL / LOCAL_PEERTOKEN）。
func PeerAuditToken(fd uintptr) ([]byte, error) {
	const solLocal, localPeerToken = 0, 6
	token := make([]byte, 32)
	n := uint32(len(token))
	fn := getsockoptAddr()
	if fn == 0 {
		return nil, errors.New("找不到 getsockopt")
	}
	r, _, _ := purego.SyscallN(fn, fd, solLocal, localPeerToken, uintptr(unsafe.Pointer(&token[0])), uintptr(unsafe.Pointer(&n)))
	runtime.KeepAlive(token)
	if int32(r) != 0 {
		return nil, errors.New("getsockopt LOCAL_PEERTOKEN 失败")
	}
	if n != 32 {
		return nil, errors.New("audit token 长度不对")
	}
	return token, nil
}

var (
	sockOnce sync.Once
	sockFn   uintptr
)

func getsockoptAddr() uintptr {
	sockOnce.Do(func() {
		lib, err := purego.Dlopen("/usr/lib/libSystem.B.dylib", purego.RTLD_NOW)
		if err == nil {
			sockFn, _ = purego.Dlsym(lib, "getsockopt")
		}
	})
	return sockFn
}
