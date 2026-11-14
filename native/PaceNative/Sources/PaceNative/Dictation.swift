import AppKit
import ApplicationServices

struct DictationSnapshot {
    let id: String
    let element: AXUIElement
    let pid: pid_t
    let bundleId: String?
    let isWebField: Bool
    let value: String
    let range: NSRange
}

@MainActor
enum DictationService {
    private static var target: DictationSnapshot?

    static func capture(_ params: [String: Any] = [:]) throws -> [String: Any] {
        target = nil
        let expectedBundleId: String?
        if let requested = params["expectedBundleId"] {
            guard let bundle = requested as? String, !bundle.isEmpty, bundle.utf8.count <= 255 else {
                throw BridgeError("invalid_params", "expectedBundleId must be a nonempty application bundle identifier.")
            }
            expectedBundleId = bundle
        } else {
            expectedBundleId = nil
        }
        let (app, element, _) = try BridgeService.focused(allowCompanion: true, expectedBundleId: expectedBundleId)
        guard let isWebField = isWebTextField(element) else {
            throw BridgeError("insertion_unavailable", "This editor could not be safely identified. Your dictation will be available to copy.")
        }
        guard let value = BridgeService.ax(element, kAXValueAttribute) as? String,
              value.utf16.count <= 100_000,
              let range = BridgeService.selectionRange(element), validDictationRange(range, in: value),
              let attribute = dictationInsertionAttribute(
                selectedTextWritable: BridgeService.isSettable(element, kAXSelectedTextAttribute),
                valueWritable: BridgeService.isSettable(element, kAXValueAttribute),
                rangeWritable: BridgeService.isSettable(element, kAXSelectedTextRangeAttribute)) else {
            throw BridgeError("insertion_unavailable", "This field does not support cursor insertion. Your dictation will be available to copy.")
        }
        let id = UUID().uuidString
        target = DictationSnapshot(id: id, element: element, pid: app.processIdentifier, bundleId: app.bundleIdentifier, isWebField: isWebField, value: value, range: range)
        return ["targetId": id, "app": app.localizedName ?? "App", "canInsert": true, "insertionMethod": isWebField ? "unicode" : attribute]
    }

    static func discard(_ params: [String: Any] = [:]) -> [String: Any] {
        if let id = params["targetId"] as? String, target?.id != id { return ["discarded": false] }
        target = nil
        return ["discarded": true]
    }

    static func insert(_ params: [String: Any]) async throws -> [String: Any] {
        guard let snapshot = target, params["targetId"] as? String == snapshot.id,
              let text = params["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              text.utf16.count <= 100_000 else {
            throw BridgeError("invalid_target", "Capture a dictation target before inserting text.")
        }
        // Consume before writing: uncertain AX responses must never cause automatic duplicate insertion.
        target = nil
        guard AXIsProcessTrusted(), NSWorkspace.shared.frontmostApplication?.processIdentifier == snapshot.pid,
              let app = NSRunningApplication(processIdentifier: snapshot.pid), !app.isTerminated,
              app.bundleIdentifier == snapshot.bundleId else {
            throw BridgeError("stale_target", "The original app lost focus. Copy your dictation instead.")
        }
        let application = AXUIElementCreateApplication(snapshot.pid)
        AXUIElementSetMessagingTimeout(application, 0.3)
        guard let focused = BridgeService.axElement(BridgeService.ax(application, kAXFocusedUIElementAttribute)),
              CFEqual(focused, snapshot.element),
              !isSecureTextField(BridgeService.ax(snapshot.element, kAXSubroleAttribute) as? String),
              let current = BridgeService.ax(snapshot.element, kAXValueAttribute) as? String,
              let range = BridgeService.selectionRange(snapshot.element),
              dictationTargetMatches(originalValue: snapshot.value, currentValue: current, originalRange: snapshot.range, currentRange: range),
              let attribute = dictationInsertionAttribute(
                selectedTextWritable: BridgeService.isSettable(snapshot.element, kAXSelectedTextAttribute),
                valueWritable: BridgeService.isSettable(snapshot.element, kAXValueAttribute),
                rangeWritable: BridgeService.isSettable(snapshot.element, kAXSelectedTextRangeAttribute)) else {
            throw BridgeError("stale_target", "The original text field or cursor changed. Copy your dictation instead.")
        }
        if snapshot.isWebField {
            return try await insertUnicode(text, snapshot: snapshot, application: application, app: app)
        }
        let expected = (snapshot.value as NSString).replacingCharacters(in: snapshot.range, with: text)
        let replacement = attribute == kAXValueAttribute ? expected : text
        let confirmed = try await performDictationWrite(write: {
            guard originalFieldFocused(snapshot, application: application, app: app),
                  let value = BridgeService.ax(snapshot.element, kAXValueAttribute) as? String,
                  let range = BridgeService.selectionRange(snapshot.element),
                  dictationTargetMatches(originalValue: snapshot.value, currentValue: value, originalRange: snapshot.range, currentRange: range) else { return .cannotComplete }
            return AXUIElementSetAttributeValue(snapshot.element, attribute as CFString, replacement as CFString)
        }, confirm: {
            guard originalFieldFocused(snapshot, application: application, app: app) else {
                throw BridgeError("insertion_unconfirmed", "The original field lost focus while insertion was being confirmed. Check the field before copying; Pace will not retry automatically.")
            }
            return BridgeService.ax(snapshot.element, kAXValueAttribute) as? String == expected
        })
        guard confirmed else {
            throw BridgeError("insertion_unconfirmed", "The app did not confirm insertion. Check the field before copying; Pace will not retry automatically.")
        }
        if attribute == kAXValueAttribute {
            var caret = CFRange(location: snapshot.range.location + text.utf16.count, length: 0)
            guard originalFieldFocused(snapshot, application: application, app: app),
                  BridgeService.ax(snapshot.element, kAXValueAttribute) as? String == expected,
                  let value = AXValueCreate(.cfRange, &caret) else {
                throw BridgeError("insertion_unconfirmed", "The text was inserted, but the original field changed. Check the field before copying; Pace will not retry automatically.")
            }
            let positioned = try await performDictationWrite(write: {
                guard originalFieldFocused(snapshot, application: application, app: app),
                      BridgeService.ax(snapshot.element, kAXValueAttribute) as? String == expected else { return .cannotComplete }
                return AXUIElementSetAttributeValue(snapshot.element, kAXSelectedTextRangeAttribute as CFString, value)
            }, confirm: {
                guard originalFieldFocused(snapshot, application: application, app: app) else {
                    throw BridgeError("insertion_unconfirmed", "The text was inserted, but the original field lost focus. Check the field before copying; Pace will not retry automatically.")
                }
                return BridgeService.ax(snapshot.element, kAXValueAttribute) as? String == expected
                    && BridgeService.selectionRange(snapshot.element) == NSRange(location: caret.location, length: 0)
            })
            guard positioned else {
                throw BridgeError("insertion_unconfirmed", "The text was inserted, but the app did not confirm the cursor position. Check the field before copying; Pace will not retry automatically.")
            }
        }
        return ["inserted": true, "insertionMethod": attribute]
    }

    private static func insertUnicode(_ text: String, snapshot: DictationSnapshot, application: AXUIElement, app: NSRunningApplication) async throws -> [String: Any] {
        let chunks = try dictationUnicodeChunks(text)
        guard CGPreflightPostEventAccess() else {
            throw BridgeError("permission_required", "Allow Pace Accessibility access to insert text. Your dictation is available to copy.")
        }
        var previous = snapshot.value
        var previousRange = snapshot.range
        for chunk in chunks {
            let expected = (previous as NSString).replacingCharacters(in: previousRange, with: chunk)
            let caret = NSRange(location: previousRange.location + chunk.utf16.count, length: 0)
            guard let (down, up) = dictationUnicodeEvents(chunk) else {
                throw BridgeError("insertion_unconfirmed", "Text insertion could not be prepared. Check the field before copying; Pace will not retry automatically.")
            }
            let confirmed = try await performDictationWrite(write: {
                guard originalFieldFocused(snapshot, application: application, app: app),
                      let current = BridgeService.ax(snapshot.element, kAXValueAttribute) as? String,
                      let range = BridgeService.selectionRange(snapshot.element),
                      dictationTargetMatches(originalValue: previous, currentValue: current, originalRange: previousRange, currentRange: range) else { return .cannotComplete }
                // Target the captured process; never broadcast keystrokes or touch the clipboard.
                down.postToPid(snapshot.pid)
                up.postToPid(snapshot.pid)
                return .success
            }, confirm: {
                guard originalFieldFocused(snapshot, application: application, app: app) else {
                    throw BridgeError("insertion_unconfirmed", "The original field lost focus during insertion. Check the field before copying; Pace will not retry automatically.")
                }
                return BridgeService.ax(snapshot.element, kAXValueAttribute) as? String == expected
                    && BridgeService.selectionRange(snapshot.element) == caret
            })
            guard confirmed else {
                throw BridgeError("insertion_unconfirmed", "The app did not confirm insertion. Check the field before copying; Pace will not retry automatically.")
            }
            previous = expected
            previousRange = caret
        }
        return ["inserted": true, "insertionMethod": "unicode"]
    }

    private static func isWebTextField(_ element: AXUIElement) -> Bool? {
        var owner: pid_t = 0
        guard AXUIElementGetPid(element, &owner) == .success else { return nil }
        return dictationWebFieldClassification(element, role: { current in
            var pid: pid_t = 0
            guard AXUIElementGetPid(current, &pid) == .success, pid == owner else { return nil }
            return BridgeService.ax(current, kAXRoleAttribute) as? String
        }, parent: { BridgeService.axElement(BridgeService.ax($0, kAXParentAttribute)) })
    }

    private static func originalFieldFocused(_ snapshot: DictationSnapshot, application: AXUIElement, app: NSRunningApplication) -> Bool {
        guard AXIsProcessTrusted(), !app.isTerminated, app.bundleIdentifier == snapshot.bundleId,
              NSWorkspace.shared.frontmostApplication?.processIdentifier == snapshot.pid else { return false }
        guard let focused = BridgeService.axElement(BridgeService.ax(application, kAXFocusedUIElementAttribute)),
              CFEqual(focused, snapshot.element),
              !isSecureTextField(BridgeService.ax(snapshot.element, kAXSubroleAttribute) as? String) else { return false }
        return true
    }
}

func dictationWebFieldClassification<Node>(_ element: Node, role: (Node) -> String?, parent: (Node) -> Node?) -> Bool? {
    var ancestor: Node? = element
    for _ in 0..<16 {
        guard let current = ancestor, let currentRole = role(current) else { return nil }
        if currentRole == "AXWebArea" { return true }
        if currentRole == kAXApplicationRole { return false }
        ancestor = parent(current)
    }
    // An incomplete ancestry must never enable a full-value write to an unidentified rich editor.
    return nil
}

@MainActor
func performDictationWrite(timeout: Duration = .milliseconds(600), write: () -> AXError, confirm: () throws -> Bool) async throws -> Bool {
    try Task.checkCancellation()
    guard write() == .success else { return false }
    // Chromium commits accessibility writes asynchronously; retry only the read, never the mutation.
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    while true {
        try Task.checkCancellation()
        if try confirm() { return true }
        if clock.now >= deadline { return false }
        try await Task.sleep(for: .milliseconds(20))
    }
}

func dictationInsertionAttribute(selectedTextWritable: @autoclosure () -> Bool, valueWritable: @autoclosure () -> Bool, rangeWritable: @autoclosure () -> Bool) -> String? {
    if selectedTextWritable() { return kAXSelectedTextAttribute }
    return valueWritable() && rangeWritable() ? kAXValueAttribute : nil
}

func dictationUnicodeChunks(_ text: String) throws -> [String] {
    guard !text.isEmpty, !text.unicodeScalars.contains(where: {
        $0.properties.generalCategory == .control || CharacterSet.newlines.contains($0) || (0xF700...0xF8FF).contains($0.value)
    }) else {
        throw BridgeError("insertion_unavailable", "This dictation contains a line break or control character. Copy it into the editor to avoid sending a command.")
    }
    var chunks: [String] = []
    var chunk = ""
    for character in text {
        let next = String(character)
        guard next.utf16.count <= 20 else {
            throw BridgeError("insertion_unavailable", "This dictation contains a character the editor cannot safely receive. Your dictation is available to copy.")
        }
        // Chromium's text injector observes a 20 UTF-16-unit event limit; keep graphemes intact.
        if chunk.utf16.count + next.utf16.count > 20 { chunks.append(chunk); chunk = "" }
        chunk += next
    }
    if !chunk.isEmpty { chunks.append(chunk) }
    return chunks
}

func dictationUnicodeEvents(_ text: String) -> (CGEvent, CGEvent)? {
    guard let source = CGEventSource(stateID: .privateState),
          let down = CGEvent(keyboardEventSource: source, virtualKey: 0x31, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: 0x31, keyDown: false) else { return nil }
    let units = Array(text.utf16)
    for event in [down, up] {
        event.flags = []
        units.withUnsafeBufferPointer { event.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress) }
    }
    return (down, up)
}

func dictationTargetMatches(originalValue: String, currentValue: String, originalRange: NSRange, currentRange: NSRange) -> Bool {
    originalValue == currentValue && originalRange == currentRange && validDictationRange(originalRange, in: originalValue)
}

private func validDictationRange(_ range: NSRange, in text: String) -> Bool {
    guard let range = Range(range, in: text) else { return false }
    return range.lowerBound.samePosition(in: text.unicodeScalars) != nil && range.upperBound.samePosition(in: text.unicodeScalars) != nil
}

@MainActor
enum CompletionService {
    private static var target: DictationSnapshot?

    static func availability() -> [String: Any] {
        do {
            let (app, element, _) = try BridgeService.focused()
            guard BridgeService.isSettable(element, kAXSelectedTextAttribute),
                  BridgeService.selectionRange(element) != nil else {
                return ["available": false, "reason": "Place your cursor in an editable text field."]
            }
            return ["available": true, "app": app.localizedName ?? "App"]
        } catch {
            return ["available": false, "reason": error.localizedDescription,
                    "permissionRequired": (error as? BridgeError)?.code == "permission_required"]
        }
    }

    static func capture() throws -> [String: Any] {
        target = nil
        let (app, element, _) = try BridgeService.focused(allowCompanion: true)
        guard let value = BridgeService.ax(element, kAXValueAttribute) as? String,
              value.utf16.count <= 100_000, let range = BridgeService.selectionRange(element),
              let context = completionContext(value: value, range: range),
              BridgeService.isSettable(element, kAXSelectedTextAttribute) else {
            throw BridgeError("insertion_unavailable", "Place the cursor in an editable text field before asking Pace to continue.")
        }
        let id = UUID().uuidString
        target = DictationSnapshot(id: id, element: element, pid: app.processIdentifier, bundleId: app.bundleIdentifier, isWebField: false, value: value, range: range)
        var result: [String: Any] = ["targetId": id, "app": app.localizedName ?? "App", "before": context["before"] ?? "", "selected": context["selected"] ?? "", "after": context["after"] ?? ""]
        if let bounds = caretBounds(element, range: range) { result["bounds"] = bounds }
        return result
    }

    static func dismiss(_ params: [String: Any] = [:]) -> [String: Any] {
        if params["targetId"] == nil || params["targetId"] as? String == target?.id { target = nil }
        return ["dismissed": true]
    }

    static func apply(_ params: [String: Any]) async throws -> [String: Any] {
        guard let snapshot = target, params["targetId"] as? String == snapshot.id,
              let text = params["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              text.utf16.count <= 100_000 else {
            throw BridgeError("invalid_target", "Request a new continuation before accepting it.")
        }
        target = nil
        guard AXIsProcessTrusted(), let app = NSRunningApplication(processIdentifier: snapshot.pid), !app.isTerminated,
              matches(snapshot) else {
            throw BridgeError("stale_target", "The original text or cursor changed. Copy the preview or request a new continuation.")
        }
        // Accept is an explicit command; only this path may restore the original application's focus.
        guard app.activate(options: []) else { throw BridgeError("focus_failed", "Pace could not return to the original app. Copy the preview instead.") }
        for _ in 0..<15 {
            if NSWorkspace.shared.frontmostApplication?.processIdentifier == snapshot.pid { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == snapshot.pid, matches(snapshot) else {
            throw BridgeError("stale_target", "The original field lost focus. Copy the preview instead.")
        }
        let expected = (snapshot.value as NSString).replacingCharacters(in: snapshot.range, with: text)
        let result = AXUIElementSetAttributeValue(snapshot.element, kAXSelectedTextAttribute as CFString, text as CFString)
        guard result == .success, BridgeService.ax(snapshot.element, kAXValueAttribute) as? String == expected else {
            throw BridgeError("insertion_unconfirmed", "The app did not confirm insertion. Check the field before copying; Pace will not retry automatically.")
        }
        return ["applied": true]
    }

    private static func matches(_ snapshot: DictationSnapshot) -> Bool {
        let application = AXUIElementCreateApplication(snapshot.pid)
        AXUIElementSetMessagingTimeout(application, 0.3)
        guard let focused = BridgeService.axElement(BridgeService.ax(application, kAXFocusedUIElementAttribute)), CFEqual(focused, snapshot.element),
              !isSecureTextField(BridgeService.ax(snapshot.element, kAXSubroleAttribute) as? String),
              let value = BridgeService.ax(snapshot.element, kAXValueAttribute) as? String,
              let range = BridgeService.selectionRange(snapshot.element),
              dictationTargetMatches(originalValue: snapshot.value, currentValue: value, originalRange: snapshot.range, currentRange: range),
              BridgeService.isSettable(snapshot.element, kAXSelectedTextAttribute) else { return false }
        return true
    }

    private static func caretBounds(_ element: AXUIElement, range: NSRange) -> [String: Double]? {
        var range = CFRange(location: range.location, length: 0)
        guard let parameter = AXValueCreate(.cfRange, &range) else { return nil }
        var result: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(element, kAXBoundsForRangeParameterizedAttribute as CFString, parameter, &result) == .success,
              let result, CFGetTypeID(result) == AXValueGetTypeID() else { return nil }
        let value = result as! AXValue
        var bounds = CGRect.zero
        guard AXValueGetType(value) == .cgRect, AXValueGetValue(value, .cgRect, &bounds),
              [bounds.origin.x, bounds.origin.y, bounds.width, bounds.height].allSatisfy({ $0.isFinite }), bounds.width >= 0, bounds.height >= 0 else { return nil }
        return ["x": bounds.origin.x, "y": bounds.origin.y, "width": bounds.width, "height": bounds.height]
    }
}

func completionContext(value: String, range: NSRange) -> [String: String]? {
    guard validDictationRange(range, in: value) else { return nil }
    let text = value as NSString
    return ["before": String(text.substring(to: range.location).suffix(3000)),
            "selected": String(text.substring(with: range).prefix(1000)),
            "after": String(text.substring(from: NSMaxRange(range)).prefix(1000))]
}
