// measure-baseline.py 的输入驱动：只发 Toskr 自己的快捷键 / Esc / 滚轮，用完把光标放回原处。
// 用法：
//   drive key cmd+shift+c | ctrl+shift+q | esc
//   drive bounds <pid>                → 输出该进程最大在屏窗口 "x y w h"（全局坐标，左上原点）
//   drive scroll <x> <y> <次数> <每次行数>   （负数向下）
import CoreGraphics
import Foundation

let a = CommandLine.arguments
func fail(_ m: String) -> Never { FileHandle.standardError.write((m + "\n").data(using: .utf8)!); exit(2) }
guard a.count >= 2 else { fail("用法见源码头部") }

let keyCodes: [String: CGKeyCode] = ["c": 8, "q": 12, "n": 45, "esc": 53]
let modFlags: [String: CGEventFlags] = ["cmd": .maskCommand, "shift": .maskShift, "ctrl": .maskControl, "alt": .maskAlternate]

switch a[1] {
case "key":
    guard a.count == 3 else { fail("key 需要组合键") }
    var flags: CGEventFlags = []
    var code: CGKeyCode?
    for part in a[2].lowercased().split(separator: "+").map(String.init) {
        if let f = modFlags[part] { flags.insert(f) } else { code = keyCodes[part] }
    }
    guard let k = code else { fail("不支持的键：\(a[2])") }
    for down in [true, false] {
        let e = CGEvent(keyboardEventSource: nil, virtualKey: k, keyDown: down)!
        e.flags = flags
        e.post(tap: .cghidEventTap)
        usleep(30_000)
    }
case "bounds":
    guard a.count == 3, let pid = Int(a[2]) else { fail("bounds 需要 pid") }
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    var best: CGRect?
    for w in list where (w[kCGWindowOwnerPID as String] as? Int) == pid {
        guard let d = w[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: d) else { continue }
        if (w[kCGWindowAlpha as String] as? Double ?? 1) < 0.5 { continue }
        if best == nil || r.width * r.height > best!.width * best!.height { best = r }
    }
    guard let r = best else { fail("无在屏窗口") }
    print("\(Int(r.minX)) \(Int(r.minY)) \(Int(r.width)) \(Int(r.height))")
case "scroll":
    guard a.count == 6, let x = Double(a[2]), let y = Double(a[3]), let n = Int(a[4]), let lines = Int32(a[5]) else { fail("scroll x y 次数 行数") }
    let saved = CGEvent(source: nil)!.location
    CGWarpMouseCursorPosition(CGPoint(x: x, y: y))
    usleep(150_000)
    for _ in 0..<n {
        let e = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: lines, wheel2: 0, wheel3: 0)!
        e.location = CGPoint(x: x, y: y)
        e.post(tap: .cghidEventTap)
        usleep(40_000)
    }
    CGWarpMouseCursorPosition(saved)
default:
    fail("未知子命令 \(a[1])")
}
