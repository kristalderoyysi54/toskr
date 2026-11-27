package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// 单写者锁：同一份数据同一时刻只让一个 Toskr 进程打开。迭代期与正式版各有各的单实例锁，指到同一个数据目录时
// 可以同时开着——后写的一方会把对方的改动当成外部修改。锁文件在数据目录里（toskr-writer.lock），
// 用 flock 持有到进程退出（崩溃时内核自动放开，不会留下死锁）；文件内容是持有者，给提示用。

const writerLockFile = "toskr-writer.lock"

var writerLocks []*os.File // 持有到进程退出

// lockDataDir：占住 dir 的写者锁。已被别的进程占着时返回错误（含持有者）。返回的函数提前放开锁（并入正式版用完即放）。
func lockDataDir(dir string) (func(), error) {
	f, err := os.OpenFile(filepath.Join(dir, writerLockFile), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		raw := make([]byte, 128)
		n, _ := f.ReadAt(raw, 0)
		f.Close()
		holder := strings.TrimSpace(string(raw[:n]))
		if holder == "" {
			holder = "另一个 Toskr"
		}
		return nil, fmt.Errorf("这份数据正被 %s 使用，请先退出它", holder)
	}
	_ = f.Truncate(0)
	_, _ = f.WriteAt([]byte(fmt.Sprintf("%s（pid %d）\n", appName(), os.Getpid())), 0)
	writerLocks = append(writerLocks, f)
	return func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN); f.Close() }, nil
}
