// Toskr 本机翻译辅助程序（中英互译）：stdin 读 {"target":"zh-Hans"|"en","lines":[...]}，
// 用系统翻译框架（macOS 15+，离线语言包）把另一种语言的行译成目标语言，其余行原样保留；
// stdout 写 {"lines":[...]} 或 {"error":"..."}。不带 lines 时只查语言包：{"status":"installed"|"supported"|"unsupported"}
// （supported = 系统支持但离线语言包未下载）。带 "prepare":true 时缺包就弹一个小窗挂系统下载确认框，
// 用户处理完（下载或取消）后回报同样的 status。
// macOS 15 只能经 SwiftUI translationTask 拿会话：翻译挂屏外 1×1 窗口，下载确认框要挂在可见窗口上。
import AppKit
import SwiftUI
import Translation

struct Input: Decodable {
    let target: String
    let lines: [String]?
    let prepare: Bool?
}

func reply(_ object: [String: Any], code: Int32) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
    exit(code)
}

guard let input = try? JSONDecoder().decode(Input.self, from: FileHandle.standardInput.readDataToEndOfFile()) else {
    reply(["error": "bad input"], code: 2)
}
let toEnglish = input.target == "en"
let source = Locale.Language(identifier: toEnglish ? "zh-Hans" : "en")
let target = Locale.Language(identifier: toEnglish ? "en" : "zh-Hans")
let sourceCode = toEnglish ? "zh" : "en"

/// 主语言是源语言的行才翻译（数字、代码、目标语言与其他语言的行保留原样）。
func needsTranslation(_ text: String) -> Bool {
    guard let tag = NSLinguisticTagger.dominantLanguage(for: text) else { return false }
    return tag.hasPrefix(sourceCode)
}

func availability() -> LanguageAvailability.Status {
    let gate = DispatchSemaphore(value: 0)
    nonisolated(unsafe) var status = LanguageAvailability.Status.unsupported
    Task.detached {
        status = await LanguageAvailability().status(from: source, to: target)
        gate.signal()
    }
    gate.wait()
    return status
}

func statusName(_ status: LanguageAvailability.Status) -> String {
    switch status {
    case .installed: "installed"
    case .supported: "supported"
    default: "unsupported"
    }
}

let app = NSApplication.shared

/// 下载确认框挂靠的小窗：系统框会以 sheet 形式贴在它上面。
struct Prepare: View {
    var body: some View {
        Text(toEnglish ? "Toskr is preparing translation languages…" : "Toskr 正在准备翻译语言包…")
            .padding(20)
            .frame(width: 340, height: 90)
            .translationTask(.init(source: source, target: target)) { session in
                try? await session.prepareTranslation()
                reply(["status": statusName(availability())], code: 0)
            }
    }
}

guard let lines = input.lines else {
    let status = availability()
    guard input.prepare == true, status == .supported else {
        reply(["status": statusName(status)], code: 0)
    }
    app.setActivationPolicy(.accessory)
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 340, height: 90), styleMask: [.titled], backing: .buffered, defer: false)
    window.title = "Toskr"
    window.contentView = NSHostingView(rootView: Prepare())
    window.center()
    window.level = .floating
    window.makeKeyAndOrderFront(nil)
    app.activate(ignoringOtherApps: true)
    // 用户迟迟不处理就按当前状态返回（下载可能仍在系统后台进行）
    DispatchQueue.main.asyncAfter(deadline: .now() + 600) { reply(["status": statusName(availability())], code: 0) }
    app.run()
    exit(0)
}

let todo = lines.indices.filter { needsTranslation(lines[$0]) }
if todo.isEmpty { reply(["lines": lines], code: 0) }

// 没装离线语言包就立即失败（否则框架要弹下载框，屏外窗口弹不出，只能干等超时）
switch availability() {
case .installed: break
case .supported: reply(["error": "language pack not installed"], code: 4)
default: reply(["error": "language pair unsupported"], code: 5)
}

struct Host: View {
    let lines: [String]
    let todo: [Int]
    var body: some View {
        Color.clear.frame(width: 1, height: 1)
            .translationTask(.init(source: source, target: target)) { session in
                var out = lines
                let requests = todo.map { TranslationSession.Request(sourceText: lines[$0], clientIdentifier: String($0)) }
                do {
                    for r in try await session.translations(from: requests) {
                        if let id = r.clientIdentifier.flatMap(Int.init) { out[id] = r.targetText }
                    }
                    reply(["lines": out], code: 0)
                } catch {
                    reply(["error": String(describing: error)], code: 1)
                }
            }
    }
}

app.setActivationPolicy(.prohibited)
let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 1, height: 1), styleMask: [.borderless], backing: .buffered, defer: false)
window.contentView = NSHostingView(rootView: Host(lines: lines, todo: todo))
window.orderFrontRegardless()
DispatchQueue.main.asyncAfter(deadline: .now() + 8) { reply(["error": "timeout"], code: 3) }
app.run()
