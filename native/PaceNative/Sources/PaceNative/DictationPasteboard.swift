import AppKit
import ApplicationServices
import Carbon.HIToolbox

struct DictationClipboardSnapshot {
    let items: [[(NSPasteboard.PasteboardType, Data)]]
    let changeCount: Int

    init(_ board: NSPasteboard) throws {
        changeCount = board.changeCount
        let originals = board.pasteboardItems ?? []
        guard originals.count <= 16 else { throw BridgeError("clipboard_unavailable", "The clipboard has too many items to preserve safely. Copy your dictation instead.") }
        var saved: [[(NSPasteboard.PasteboardType, Data)]] = []
        var bytes = 0
        for item in originals {
            guard !item.types.isEmpty, item.types.count <= 128 else { throw BridgeError("clipboard_unavailable", "The clipboard formats could not be preserved safely. Copy your dictation instead.") }
            var values: [(NSPasteboard.PasteboardType, Data)] = []
            for type in item.types {
                guard !type.rawValue.lowercased().contains("promise") else { throw BridgeError("clipboard_unavailable", "The clipboard contains a deferred file promise that cannot be preserved safely. Copy your dictation instead.") }
                guard let data = item.data(forType: type), data.count <= 16 * 1024 * 1024 else { throw BridgeError("clipboard_unavailable", "A clipboard format could not be preserved safely. Copy your dictation instead.") }
                bytes += data.count
                guard bytes <= 32 * 1024 * 1024 else { throw BridgeError("clipboard_unavailable", "The clipboard is too large to preserve safely. Copy your dictation instead.") }
                values.append((type, data))
            }
            saved.append(values)
        }
        guard board.changeCount == changeCount else { throw BridgeError("clipboard_changed", "The clipboard changed while it was being preserved. Copy your dictation instead.") }
        items = saved
    }

    func restore(_ board: NSPasteboard, write: (NSPasteboard, [NSPasteboardItem]) -> Bool = { $0.writeObjects($1) }) -> (restored: Bool, generation: Int) {
        let restored = items.map { values -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (type, data) in values { item.setData(data, forType: type) }
            return item
        }
        let generation = board.prepareForNewContents(with: .currentHostOnly)
        return (restored.isEmpty || write(board, restored), generation)
    }
}

final class DictationTranscriptPromise: NSObject, NSPasteboardItemDataProvider {
    static let sessionType = NSPasteboard.PasteboardType("app.desktoppets.pace.dictation-session")
    let session = UUID().uuidString
    private(set) var item = NSPasteboardItem()
    let text: String
    private(set) var readAt: TimeInterval?
    private(set) var changeCount = -1
    private var ownedEmptyGeneration: Int?

    init(_ text: String) { self.text = text }

    func publish(_ board: NSPasteboard) -> Bool {
        item.setData(Data(), forType: NSPasteboard.PasteboardType("org.nspasteboard.TransientType"))
        item.setData(Data(session.utf8), forType: Self.sessionType)
        item.setDataProvider(self, forTypes: [.string])
        changeCount = board.prepareForNewContents(with: .currentHostOnly)
        ownedEmptyGeneration = changeCount
        guard board.writeObjects([item]) else { return false }
        changeCount = board.changeCount
        ownedEmptyGeneration = nil
        return true
    }

    func owns(_ board: NSPasteboard) -> Bool {
        board.changeCount == changeCount && (board.data(forType: Self.sessionType) == Data(session.utf8)
            || ownedEmptyGeneration == changeCount && board.pasteboardItems?.isEmpty != false)
    }

    func recoverFailedRestore(_ board: NSPasteboard, generation: Int) {
        guard board.changeCount == generation, board.pasteboardItems?.isEmpty != false else { return }
        changeCount = generation
        ownedEmptyGeneration = generation
        let replacement = NSPasteboardItem()
        replacement.setData(Data(session.utf8), forType: Self.sessionType)
        replacement.setData(Data(), forType: .init("org.nspasteboard.TransientType"))
        replacement.setString(text, forType: .string)
        if board.writeObjects([replacement]) {
            item = replacement
            changeCount = board.changeCount
            ownedEmptyGeneration = nil
        }
    }

    func materialize() { item.setString(text, forType: .string) }

    func pasteboard(_ pasteboard: NSPasteboard?, item: NSPasteboardItem, provideDataForType type: NSPasteboard.PasteboardType) {
        item.setString(text, forType: type)
        if readAt == nil { readAt = ProcessInfo.processInfo.systemUptime }
    }
}

@MainActor
final class DictationPasteboard {
    static let shared = DictationPasteboard(.general)
    private let board: NSPasteboard
    private let readBudget: TimeInterval
    private let settle: TimeInterval
    private let modifiersReleased: () -> Bool
    private let writeRestore: (NSPasteboard, [NSPasteboardItem]) -> Bool
    private var busy = false
    // shortcut: recovery lives only in memory until Restore, a new copy, or app quit; never persist clipboard contents.
    private var recovery: (id: String, original: DictationClipboardSnapshot, promise: DictationTranscriptPromise)?

    init(_ board: NSPasteboard, readBudget: TimeInterval = 3, settle: TimeInterval = 0.45, modifiersReleased: @escaping () -> Bool = dictationModifiersReleased, writeRestore: @escaping (NSPasteboard, [NSPasteboardItem]) -> Bool = { $0.writeObjects($1) }) {
        self.board = board; self.readBudget = readBudget; self.settle = settle; self.modifiersReleased = modifiersReleased; self.writeRestore = writeRestore
    }

    func current() -> [String: Any] {
        releaseReplacedRecovery()
        return ["recoveries": recovery.map { [["recoveryId": $0.id]] } ?? []]
    }

    func restore(_ id: String) throws -> [String: Any] {
        guard !busy else { throw BridgeError("clipboard_busy", "Wait for the current paste to finish before restoring the clipboard.") }
        guard let saved = recovery, saved.id == id else { return ["restored": false] }
        guard saved.promise.owns(board) else { recovery = nil; return ["restored": false, "reason": "clipboard_changed"] }
        guard restoreOriginal(saved.original, promise: saved.promise) else { throw BridgeError("clipboard_unavailable", "The clipboard could not be restored. Its saved formats are still available; try Restore again.") }
        recovery = nil
        return ["restored": true]
    }

    func paste(_ text: String, validate: () -> Bool, verify: () -> Bool?, post: () -> Void) async throws -> [String: Any] {
        releaseReplacedRecovery()
        guard !busy, recovery == nil else { throw BridgeError("clipboard_busy", "Finish or restore the previous clipboard paste before dictating again.") }
        busy = true
        defer { busy = false }
        try await waitForDictationModifiers(released: modifiersReleased)
        guard validate() else { throw BridgeError("stale_target", "The original text field or cursor changed. Copy your dictation instead.") }
        let original = try DictationClipboardSnapshot(board)
        guard validate(), board.changeCount == original.changeCount else { throw BridgeError("stale_target", "The original field or clipboard changed. Copy your dictation instead.") }
        try Task.checkCancellation()
        let promise = DictationTranscriptPromise(text)
        guard promise.publish(board) else {
            if promise.owns(board), !restoreOriginal(original, promise: promise) {
                return retain(original, promise: promise, read: false, verified: false, error: "The clipboard could not be prepared or restored. Restore your previous clipboard when ready.", dispatched: false)
            }
            throw BridgeError("clipboard_unavailable", "The dictation clipboard could not be prepared.")
        }
        guard validate(), !Task.isCancelled else {
            if promise.owns(board), !restoreOriginal(original, promise: promise) {
                return retain(original, promise: promise, read: false, verified: false, error: "Dictation stopped before paste, but the clipboard could not be restored. Restore your previous clipboard when ready.", dispatched: false)
            }
            throw BridgeError("stale_target", "The original field changed before paste. Copy your dictation instead.")
        }
        post()
        let postedAt = ProcessInfo.processInfo.systemUptime
        // Cancellation after dispatch retains recovery; never restore before a possible late paste or dispatch again.
        while promise.readAt == nil, promise.owns(board), ProcessInfo.processInfo.systemUptime < postedAt + readBudget {
            if Task.isCancelled { return cancelled(original, promise: promise) }
            await delay(0.02)
        }
        if Task.isCancelled { return cancelled(original, promise: promise) }
        let read = promise.readAt != nil
        if let readAt = promise.readAt {
            let until = max(postedAt + settle, readAt + 0.05)
            while ProcessInfo.processInfo.systemUptime < until {
                if Task.isCancelled { return cancelled(original, promise: promise) }
                await delay(0.02)
            }
        }
        if Task.isCancelled { return cancelled(original, promise: promise) }
        let verified = verify() == true
        if read && verified {
            if promise.owns(board), !restoreOriginal(original, promise: promise) {
                return retain(original, promise: promise, read: true, verified: verified, error: "The paste was dispatched, but the clipboard could not be restored.")
            }
            return ["inserted": verified, "verified": verified, "dispatched": true, "clipboardRead": true]
        }
        if read { return retain(original, promise: promise, read: true, verified: false, error: nil) }
        return retain(original, promise: promise, read: false, verified: verified, error: "The editor did not confirm reading the paste. Check the editor before copying; Pace will not paste again automatically. Restore your previous clipboard when ready.")
    }

    private func cancelled(_ original: DictationClipboardSnapshot, promise: DictationTranscriptPromise) -> [String: Any] {
        retain(original, promise: promise, read: promise.readAt != nil, verified: false, error: "Paste was dispatched before dictation ended. Check the editor before copying; Pace will not paste again. Restore your previous clipboard when ready.")
    }

    private func restoreOriginal(_ original: DictationClipboardSnapshot, promise: DictationTranscriptPromise) -> Bool {
        let attempt = original.restore(board, write: writeRestore)
        if !attempt.restored { promise.recoverFailedRestore(board, generation: attempt.generation) }
        return attempt.restored
    }

    private func retain(_ original: DictationClipboardSnapshot, promise: DictationTranscriptPromise, read: Bool, verified: Bool, error: String?, dispatched: Bool = true) -> [String: Any] {
        var result: [String: Any] = ["inserted": read && verified, "verified": read && verified, "dispatched": dispatched, "clipboardRead": read]
        if let error { result["insertionError"] = error }
        if promise.owns(board) {
            promise.materialize()
            let id = UUID().uuidString
            recovery = (id, original, promise)
            result["clipboardRecoveryId"] = id
        }
        return result
    }

    private func releaseReplacedRecovery() {
        if let recovery, !recovery.promise.owns(board) { self.recovery = nil }
    }

    private func delay(_ seconds: TimeInterval) async {
        await withCheckedContinuation { continuation in
            DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { continuation.resume() }
        }
    }
}

func dictationKeyboardIsPlainLayout() -> Bool {
    guard let source = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue(),
          let type = TISGetInputSourceProperty(source, kTISPropertyInputSourceType) else { return false }
    return Unmanaged<CFString>.fromOpaque(type).takeUnretainedValue() == kTISTypeKeyboardLayout
}

func dictationPasteKey() -> CGKeyCode? {
    let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue()
    let ascii = TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue()
    func data(_ source: TISInputSource?) -> Data? {
        guard let source, let pointer = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return nil }
        return Unmanaged<CFData>.fromOpaque(pointer).takeUnretainedValue() as Data
    }
    guard let layout = data(source) ?? data(ascii) else { return nil }
    return layout.withUnsafeBytes { buffer in
        guard let pointer = buffer.baseAddress else { return nil }
        for key in 0..<128 {
            var dead: UInt32 = 0
            var length = 0
            var characters = [UniChar](repeating: 0, count: 4)
            let status = UCKeyTranslate(pointer.assumingMemoryBound(to: UCKeyboardLayout.self), UInt16(key), UInt16(kUCKeyActionDisplay), UInt32(cmdKey) >> 8, UInt32(LMGetKbdType()), OptionBits(kUCKeyTranslateNoDeadKeysBit), &dead, characters.count, &length, &characters)
            if status == noErr, String(utf16CodeUnits: characters, count: length) == "v" { return CGKeyCode(key) }
        }
        return nil
    }
}

func dictationModifiersReleased() -> Bool {
    CGEventSource.flagsState(.combinedSessionState).intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift]).isEmpty
}

func waitForDictationModifiers(timeout: Duration = .milliseconds(1500), released: () -> Bool = dictationModifiersReleased) async throws {
    try Task.checkCancellation()
    let clock = ContinuousClock(), deadline = ContinuousClock.now.advanced(by: timeout)
    while !released() {
        try Task.checkCancellation()
        guard clock.now < deadline else { throw BridgeError("modifiers_held", "Release the shortcut keys before inserting dictation. Your words are available to copy.") }
        try await Task.sleep(for: .milliseconds(20))
    }
    try Task.checkCancellation()
}
