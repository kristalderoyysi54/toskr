// macprobe：只读自检原生层（不改剪贴板、不发按键）。
package main

import (
	"fmt"

	"github.com/toskr/native/internal/macos"
)

func main() {
	front, ok := macos.Frontmost()
	fmt.Printf("frontmost ok=%v pid=%d bundle=%q\n", ok, front.PID, front.BundleID)
	fmt.Println("ax trusted:", macos.AXTrusted(false))
	fmt.Println("pasteboard changeCount:", macos.ChangeCount(), "types:", len(macos.Types()))
	items := macos.Snapshot()
	n := 0
	for _, it := range items {
		n += len(it)
	}
	fmt.Println("snapshot items:", len(items), "type entries:", n)
	kind, s := macos.SelectedText()
	fmt.Println("ax selection kind:", kind, "len:", len(s))
}
