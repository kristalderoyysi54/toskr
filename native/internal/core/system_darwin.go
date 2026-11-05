//go:build darwin

package core

import (
	"os"
	"time"

	"github.com/toskr/native/internal/macos"
)

// Mac 是真实系统实现。
type Mac struct{}

func (Mac) Frontmost() (macos.FrontApp, bool)           { return macos.Frontmost() }
func (Mac) SelectedText() (macos.Selection, string)     { return macos.SelectedText() }
func (Mac) ChangeCount() int                            { return macos.ChangeCount() }
func (Mac) Types() []string                             { return macos.Types() }
func (Mac) ReadString() (string, string)                { return macos.ReadString() }
func (Mac) Snapshot() []macos.Item                      { return macos.Snapshot() }
func (Mac) Write(items []macos.Item, transient bool) int { return macos.Write(items, transient) }
func (Mac) PostKey(k uint16, f uint64)                  { macos.PostKey(k, f) }
func (Mac) Activate(pid int32) bool                     { return macos.Activate(pid) }
func (Mac) Sleep(d time.Duration)                       { time.Sleep(d) }
func (Mac) SelfPID() int32                              { return int32(os.Getpid()) }
