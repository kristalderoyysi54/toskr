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

/// 查语言包状态。只在主线程跑着 runloop 时 await，不用信号量卡住主线程等它：
/// 系统翻译服务的回调可能要回到主线程，卡住就是死锁（设置页曾一直「检查中…」）。
@Sendable func availability() async -> LanguageAvailability.Status {
    await LanguageAvailability().status(from: source, to: target)
}

@Sendable func statusName(_ status: LanguageAvailability.Status) -> String {
    switch status {
    case .installed: "installed"
    case .supported: "supported"
    default: "unsupported"
    }
}

let app = NSApplication.shared
/// 挂翻译会话 / 下载确认框的窗口，全局持有免得被提前释放。
nonisolated(unsafe) var hostWindow: NSWindow?

/// 下载确认框挂靠的小窗：系统框会以 sheet 形式贴在它上面。
struct Prepare: View {
    var body: some View {
        Text(toEnglish ? "Toskr is preparing translation languages…" : "Toskr 正在准备翻译语言包…")
            .padding(20)
            .frame(width: 340, height: 90)
            .translationTask(.init(source: source, target: target)) { session in
                try? await session.prepareTranslation()
                reply(["status": statusName(await availability())], code: 0)
            }
    }
}

/// 缺包时弹小窗挂系统下载确认框。
@MainActor func showPrepareWindow() {
    app.setActivationPolicy(.accessory)
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 340, height: 90), styleMask: [.titled], backing: .buffered, defer: false)
    window.title = "Toskr"
    window.contentView = NSHostingView(rootView: Prepare())
    window.center()
    window.level = .floating
    window.makeKeyAndOrderFront(nil)
    hostWindow = window
    app.activate(ignoringOtherApps: true)
    // 用户迟迟不处理就按当前状态返回（下载可能仍在系统后台进行）
    DispatchQueue.main.asyncAfter(deadline: .now() + 600) {
        Task { reply(["status": statusName(await availability())], code: 0) }
    }
}

let todo = input.lines.map { lines in lines.indices.filter { needsTranslation(lines[$0]) } } ?? []
if let lines = input.lines, todo.isEmpty { reply(["lines": lines], code: 0) }

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
// 查状态 / 翻译都有总超时（下载确认要等用户，单独 10 分钟）；系统服务不应答也能退出
if input.prepare != true {
    DispatchQueue.main.asyncAfter(deadline: .now() + (input.lines == nil ? 6 : 8)) { reply(["error": "timeout"], code: 3) }
}
Task { @MainActor in
    let status = await availability()
    guard let lines = input.lines else {
        guard input.prepare == true, status == .supported else {
            reply(["status": statusName(status)], code: 0)
        }
        showPrepareWindow()
        return
    }
    // 没装离线语言包就立即失败（否则框架要弹下载框，屏外窗口弹不出，只能干等超时）
    switch status {
    case .installed: break
    case .supported: reply(["error": "language pack not installed"], code: 4)
    default: reply(["error": "language pair unsupported"], code: 5)
    }
    let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 1, height: 1), styleMask: [.borderless], backing: .buffered, defer: false)
    window.contentView = NSHostingView(rootView: Host(lines: lines, todo: todo))
    window.orderFrontRegardless()
    hostWindow = window
}
app.run()
