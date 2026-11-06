//go:build darwin

package macos

import (
	"unsafe"

	"github.com/ebitengine/purego/objc"
)

const (
	TypeString = "public.utf8-plain-text"
	TypeHTML   = "public.html"
	TypePNG    = "public.png"
	// TypeTransient 标记临时内容，剪贴板管理器（含本应用）会忽略。
	TypeTransient = "org.nspasteboard.TransientType"
)

func general() objc.ID { return class("NSPasteboard").Send(sel("generalPasteboard")) }

// ChangeCount 是系统剪贴板的修改计数。
func ChangeCount() int {
	load()
	n := 0
	withPool(func() { n = objc.Send[int](general(), sel("changeCount")) })
	return n
}

// ReadString 读剪贴板的纯文本与 HTML（不存在的类型为空串）。
func ReadString() (text, html string) {
	load()
	withPool(func() {
		pb := general()
		text = goString(uintptr(pb.Send(sel("stringForType:"), nsString(TypeString))))
		html = goString(uintptr(pb.Send(sel("stringForType:"), nsString(TypeHTML))))
	})
	return
}

// Types 返回剪贴板第一项的类型列表。
func Types() []string {
	load()
	var out []string
	withPool(func() {
		types := general().Send(sel("types"))
		n := objc.Send[int](types, sel("count"))
		for i := 0; i < n; i++ {
			out = append(out, goString(uintptr(types.Send(sel("objectAtIndex:"), i))))
		}
	})
	return out
}

// Item 是剪贴板一项的全部类型数据快照。
type Item map[string][]byte

// Snapshot 拷贝剪贴板全部项与类型数据，供事务结束后原样还原。
func Snapshot() []Item {
	load()
	var items []Item
	withPool(func() {
		arr := general().Send(sel("pasteboardItems"))
		n := objc.Send[int](arr, sel("count"))
		for i := 0; i < n; i++ {
			it := arr.Send(sel("objectAtIndex:"), i)
			types := it.Send(sel("types"))
			m := Item{}
			for j, c := 0, objc.Send[int](types, sel("count")); j < c; j++ {
				t := types.Send(sel("objectAtIndex:"), j)
				data := it.Send(sel("dataForType:"), t)
				if data == 0 {
					continue
				}
				m[goString(uintptr(t))] = nsDataBytes(data)
			}
			items = append(items, m)
		}
	})
	return items
}

// Write 清空剪贴板并写入若干项；transient 为真时附加临时标记。返回新的 changeCount。
func Write(items []Item, transient bool) int {
	load()
	n := 0
	withPool(func() {
		pb := general()
		pb.Send(sel("clearContents"))
		arr := class("NSMutableArray").Send(sel("array"))
		for _, item := range items {
			pi := class("NSPasteboardItem").Send(sel("alloc")).Send(sel("init")).Send(sel("autorelease"))
			for t, b := range item {
				pi.Send(sel("setData:forType:"), nsData(b), nsString(t))
			}
			if transient {
				pi.Send(sel("setData:forType:"), nsData([]byte{}), nsString(TypeTransient))
			}
			arr.Send(sel("addObject:"), pi)
		}
		objc.Send[bool](pb, sel("writeObjects:"), arr)
		n = objc.Send[int](pb, sel("changeCount"))
	})
	return n
}

// WriteText 以单项纯文本写入。
func WriteText(s string, transient bool) int {
	return Write([]Item{{TypeString: []byte(s)}}, transient)
}

func nsData(b []byte) objc.ID {
	if len(b) == 0 {
		return class("NSData").Send(sel("data"))
	}
	return class("NSData").Send(sel("dataWithBytes:length:"), unsafe.Pointer(&b[0]), len(b))
}

func nsDataBytes(d objc.ID) []byte {
	n := objc.Send[int](d, sel("length"))
	if n == 0 {
		return []byte{}
	}
	p := objc.Send[unsafe.Pointer](d, sel("bytes"))
	return append([]byte(nil), unsafe.Slice((*byte)(p), n)...)
}

// TypeFileURL：Finder 复制文件时每项一个 file:// URL。
const TypeFileURL = "public.file-url"

// ImageToPNG 用 ImageIO（NSBitmapImageRep）把任意系统可读的位图（JPEG/HEIC/GIF/TIFF/PNG…）转成 PNG；不认识返回 nil。
func ImageToPNG(data []byte) []byte {
	if len(data) == 0 {
		return nil
	}
	load()
	var out []byte
	withPool(func() {
		rep := class("NSBitmapImageRep").Send(sel("imageRepWithData:"), nsData(data))
		if rep == 0 {
			return
		}
		const pngFileType = 4 // NSBitmapImageFileTypePNG
		png := rep.Send(sel("representationUsingType:properties:"), uint(pngFileType), class("NSDictionary").Send(sel("dictionary")))
		if png != 0 {
			out = nsDataBytes(png)
		}
	})
	return out
}
