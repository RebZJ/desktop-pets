import AppKit
import ApplicationServices

struct DictationSnapshot {
    let id: String
    let element: AXUIElement
    let pid: pid_t
    let value: String
    let range: NSRange
}

@MainActor
enum DictationService {
    private static var target: DictationSnapshot?

    static func capture() throws -> [String: Any] {
        target = nil
        let (app, element, _) = try BridgeService.focused(allowCompanion: true)
        guard let value = BridgeService.ax(element, kAXValueAttribute) as? String,
              value.utf16.count <= 100_000,
              let range = BridgeService.selectionRange(element), validDictationRange(range, in: value),
              BridgeService.isSettable(element, kAXSelectedTextAttribute) else {
            throw BridgeError("insertion_unavailable", "This field does not support cursor insertion. Your dictation will be available to copy.")
        }
        let id = UUID().uuidString
        target = DictationSnapshot(id: id, element: element, pid: app.processIdentifier, value: value, range: range)
        return ["targetId": id, "app": app.localizedName ?? "App", "canInsert": true]
    }

    static func discard() -> [String: Any] {
        target = nil
        return ["discarded": true]
    }

    static func insert(_ params: [String: Any]) throws -> [String: Any] {
        guard let snapshot = target, params["targetId"] as? String == snapshot.id,
              let text = params["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              text.utf16.count <= 100_000 else {
            throw BridgeError("invalid_target", "Capture a dictation target before inserting text.")
        }
        // Consume before writing: uncertain AX responses must never cause automatic duplicate insertion.
        target = nil
        guard AXIsProcessTrusted(), NSWorkspace.shared.frontmostApplication?.processIdentifier == snapshot.pid,
              let app = NSRunningApplication(processIdentifier: snapshot.pid), !app.isTerminated else {
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
              BridgeService.isSettable(snapshot.element, kAXSelectedTextAttribute) else {
            throw BridgeError("stale_target", "The original text field or cursor changed. Copy your dictation instead.")
        }
        let expected = (snapshot.value as NSString).replacingCharacters(in: snapshot.range, with: text)
        let result = AXUIElementSetAttributeValue(snapshot.element, kAXSelectedTextAttribute as CFString, text as CFString)
        guard result == .success, BridgeService.ax(snapshot.element, kAXValueAttribute) as? String == expected else {
            throw BridgeError("insertion_unconfirmed", "The app did not confirm insertion. Check the field before copying; Pace will not retry automatically.")
        }
        return ["inserted": true]
    }
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
        target = DictationSnapshot(id: id, element: element, pid: app.processIdentifier, value: value, range: range)
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
