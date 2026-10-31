// Toskr 本机翻译辅助程序（中英互译）：stdin 读 {"target":"zh-Hans"|"en","lines":[...]}，
// 用系统翻译框架（macOS 15+，离线语言包）把另一种语言的行译成目标语言，其余行原样保留；
// stdout 写 {"lines":[...]} 或 {"error":"..."}。
// macOS 15 只能经 SwiftUI translationTask 拿会话，所以挂一个屏外 1×1 窗口。
import AppKit
import SwiftUI
import Translation

struct Input: Decodable {
    let target: String
    let lines: [String]
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

let todo = input.lines.indices.filter { needsTranslation(input.lines[$0]) }
if todo.isEmpty { reply(["lines": input.lines], code: 0) }

// 没装离线语言包就立即失败（否则框架要弹下载框，屏外窗口弹不出，只能干等超时）
let gate = DispatchSemaphore(value: 0)
nonisolated(unsafe) var installed = false
Task.detached {
    installed = await LanguageAvailability().status(from: source, to: target) == .installed
    gate.signal()
}
gate.wait()
if !installed { reply(["error": "language pack not installed"], code: 4) }

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

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 1, height: 1), styleMask: [.borderless], backing: .buffered, defer: false)
window.contentView = NSHostingView(rootView: Host(lines: input.lines, todo: todo))
window.orderFrontRegardless()
DispatchQueue.main.asyncAfter(deadline: .now() + 8) { reply(["error": "timeout"], code: 3) }
app.run()
