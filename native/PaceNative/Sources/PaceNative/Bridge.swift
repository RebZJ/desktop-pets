import AppKit
import ApplicationServices
import AVFoundation

struct BridgeError: LocalizedError {
    let code: String
    let message: String
    var errorDescription: String? { message }
    init(_ code: String, _ message: String) { self.code = code; self.message = message }
}

struct WritingSnapshot {
    let element: AXUIElement
    let pid: pid_t
    let fieldValue: String
    let selectedText: String
    let range: NSRange?
    let scope: String
}

@MainActor
enum BridgeService {
    private static var writingContexts: [String: WritingSnapshot] = [:]

    static func handle(method: String, params: [String: Any], emit: @escaping ([String: Any]) -> Void) async throws -> [String: Any]? {
        switch method {
        case "permissions.status": return permissionStatus()
        case "permissions.request":
            switch params["kind"] as? String ?? "accessibility" {
            case "accessibility":
                _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
            case "microphone": _ = await AVCaptureDevice.requestAccess(for: .audio)
            case "screenRecording": _ = CGRequestScreenCaptureAccess()
            default: throw BridgeError("invalid_permission", "Unknown permission kind.")
            }
            return permissionStatus()
        case "apps.list":
            return ["apps": NSWorkspace.shared.runningApplications.compactMap { app -> [String: Any]? in
                guard app.activationPolicy == .regular, let bundle = app.bundleIdentifier else { return nil }
                return ["bundleId": bundle, "name": app.localizedName ?? bundle, "pid": app.processIdentifier, "isActive": app.isActive]
            }.sorted { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") }]
        case "writing.capture": return try captureWriting()
        case "writing.apply": return try applyWriting(params)
        case "dictation.capture": return try DictationService.capture(params)
        case "dictation.insert": return try await DictationService.insert(params)
        case "dictation.discard": return DictationService.discard(params)
        case "completion.available": return CompletionService.availability()
        case "completion.capture": return try CompletionService.capture()
        case "completion.apply": return try await CompletionService.apply(params)
        case "completion.dismiss": return CompletionService.dismiss(params)
        case "memory.capture": return try captureMemory(params)
        default:
            if let result = try await MeetingService.handle(method: method, params: params, emit: emit) { return result }
            #if PACE_PLATFORM_ONLY
            return nil
            #else
            return try await DiarizationService.handle(method: method, params: params, emit: emit)
            #endif
        }
    }

    static func permissionStatus() -> [String: Any] {
        let microphone: String
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: microphone = "granted"
        case .notDetermined: microphone = "notDetermined"
        case .restricted: microphone = "restricted"
        case .denied: microphone = "denied"
        @unknown default: microphone = "unknown"
        }
        return ["accessibility": AXIsProcessTrusted() ? "granted" : "denied", "microphone": microphone,
                "screenRecording": CGPreflightScreenCaptureAccess() ? "granted" : "denied"]
    }

    static func ax(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        var result: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &result) == .success else { return nil }
        return result
    }

    static func axElement(_ value: CFTypeRef?) -> AXUIElement? {
        guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }

    static func focused(allowCompanion: Bool = false, expectedBundleId: String? = nil) throws -> (NSRunningApplication, AXUIElement, AXUIElement?) {
        guard AXIsProcessTrusted() else { throw BridgeError("permission_required", "Enable Accessibility in System Settings to read selected text.") }
        guard let app = NSWorkspace.shared.frontmostApplication else { throw BridgeError("no_focused_app", "No application has focus.") }
        guard expectedBundleId == nil || app.bundleIdentifier == expectedBundleId else {
            throw BridgeError("unexpected_app", "The requested dictation app is not focused (frontmost PID: \(app.processIdentifier)). Focus it and try again.")
        }
        guard app.processIdentifier != ProcessInfo.processInfo.processIdentifier,
              (!isBlockedApplication(app.bundleIdentifier ?? "") || (allowCompanion && app.bundleIdentifier == "app.desktoppets.pace")) else {
            throw BridgeError("excluded_app", "Pace does not read \(app.localizedName ?? "this application") (\(app.bundleIdentifier ?? "unknown application")).")
        }
        let application = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(application, 0.3)
        guard let element = axElement(ax(application, kAXFocusedUIElementAttribute)) else {
            throw BridgeError("text_unavailable", "This app does not expose a focused text field. Copy text into Pace instead.")
        }
        AXUIElementSetMessagingTimeout(element, 0.3)
        guard !isSecureTextField(ax(element, kAXSubroleAttribute) as? String) else {
            throw BridgeError("secure_field", "Pace does not read password fields.")
        }
        return (app, element, axElement(ax(application, kAXFocusedWindowAttribute)))
    }

    static func selectionRange(_ element: AXUIElement) -> NSRange? {
        guard let value = ax(element, kAXSelectedTextRangeAttribute), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        let axValue = value as! AXValue
        guard AXValueGetType(axValue) == .cfRange else { return nil }
        var range = CFRange()
        guard AXValueGetValue(axValue, .cfRange, &range), range.location >= 0, range.length >= 0 else { return nil }
        return NSRange(location: range.location, length: range.length)
    }

    private static func captureWriting() throws -> [String: Any] {
        let (app, element, window) = try focused()
        let value = ax(element, kAXValueAttribute) as? String ?? ""
        guard value.utf16.count <= 100_000 else { throw BridgeError("text_too_large", "Select a smaller passage to edit in Pace.") }
        let range = selectionRange(element)
        var selected = ax(element, kAXSelectedTextAttribute) as? String ?? ""
        if selected.isEmpty, let range, NSMaxRange(range) <= value.utf16.count {
            selected = (value as NSString).substring(with: range)
        }
        let scope = selected.isEmpty ? (value.isEmpty ? "empty" : "draft") : "selection"
        let id = UUID().uuidString
        // One pending target prevents accidental reuse of a stale field from an earlier command.
        writingContexts = [id: WritingSnapshot(element: element, pid: app.processIdentifier, fieldValue: value, selectedText: selected, range: range, scope: scope)]
        let context = window.map { visibleText($0) } ?? ""
        return ["contextId": id, "app": app.localizedName ?? "App", "bundleId": app.bundleIdentifier ?? "", "scope": scope,
                "text": scope == "selection" ? selected : value, "context": maskSensitive(context),
                "canApply": isSettable(element, scope == "draft" ? kAXValueAttribute : kAXSelectedTextAttribute)]
    }

    static func isSettable(_ element: AXUIElement, _ attribute: String) -> Bool {
        var writable = DarwinBoolean(false)
        return AXUIElementIsAttributeSettable(element, attribute as CFString, &writable) == .success && writable.boolValue
    }

    private static func applyWriting(_ params: [String: Any]) throws -> [String: Any] {
        guard let id = params["contextId"] as? String, let snapshot = writingContexts[id], let text = params["text"] as? String else {
            throw BridgeError("invalid_context", "Capture a writing target before applying text.")
        }
        guard text.utf16.count <= 100_000 else { throw BridgeError("text_too_large", "The generated text is too long to insert.") }
        guard AXIsProcessTrusted(), let app = NSRunningApplication(processIdentifier: snapshot.pid), !app.isTerminated else {
            throw BridgeError("stale_target", "The original app is no longer available. Copy the preview instead.")
        }
        app.activate(options: [])
        let application = AXUIElementCreateApplication(snapshot.pid)
        AXUIElementSetMessagingTimeout(application, 0.3)
        guard let focusedElement = axElement(ax(application, kAXFocusedUIElementAttribute)), CFEqual(focusedElement, snapshot.element) else {
            throw BridgeError("stale_target", "The original field lost focus. Copy the preview or capture the field again.")
        }
        let currentValue = ax(snapshot.element, kAXValueAttribute) as? String ?? ""
        let currentRange = selectionRange(snapshot.element)
        var currentSelection = ax(snapshot.element, kAXSelectedTextAttribute) as? String ?? ""
        if currentSelection.isEmpty, let currentRange, NSMaxRange(currentRange) <= currentValue.utf16.count {
            currentSelection = (currentValue as NSString).substring(with: currentRange)
        }
        guard writingTargetMatches(originalValue: snapshot.fieldValue, currentValue: currentValue, originalRange: snapshot.range, currentRange: currentRange, originalSelection: snapshot.selectedText, currentSelection: currentSelection),
              !isSecureTextField(ax(snapshot.element, kAXSubroleAttribute) as? String) else {
            throw BridgeError("stale_target", "The text or selection changed. Copy the preview or capture the field again.")
        }
        let result: AXError
        if snapshot.scope == "selection" || snapshot.scope == "empty" {
            guard isSettable(snapshot.element, kAXSelectedTextAttribute) else { return ["applied": false, "fallback": "copy", "reason": "This field does not support direct insertion."] }
            result = AXUIElementSetAttributeValue(snapshot.element, kAXSelectedTextAttribute as CFString, text as CFString)
        } else {
            guard isSettable(snapshot.element, kAXValueAttribute) else { return ["applied": false, "fallback": "copy", "reason": "This field does not support direct replacement."] }
            result = AXUIElementSetAttributeValue(snapshot.element, kAXValueAttribute as CFString, text as CFString)
        }
        writingContexts.removeValue(forKey: id)
        guard result == .success else { throw BridgeError("apply_failed", "The app did not confirm insertion. Check the field before copying the preview; Pace will not retry automatically.") }
        return ["applied": true]
    }

    private static func captureMemory(_ params: [String: Any]) throws -> [String: Any] {
        guard let allowed = params["allowedApps"] as? [String], !allowed.isEmpty else { return ["captured": false, "reason": "no_allowed_apps"] }
        guard let front = NSWorkspace.shared.frontmostApplication, let bundle = front.bundleIdentifier, allowed.contains(bundle) else {
            return ["captured": false, "reason": "app_not_allowed"]
        }
        let (app, _, window) = try focused()
        guard let window else { return ["captured": false, "reason": "no_window"] }
        let browser = bundle.localizedCaseInsensitiveContains("safari") || bundle.localizedCaseInsensitiveContains("chrome") || bundle.localizedCaseInsensitiveContains("firefox") || bundle.localizedCaseInsensitiveContains("brave") || bundle.localizedCaseInsensitiveContains("edge") || bundle.localizedCaseInsensitiveContains("arc")
        if browser {
            // shortcut: AX cannot reliably identify private browsing across browsers; background browser capture stays off until a browser integration supplies that boundary.
            return ["captured": false, "reason": "browser_capture_requires_integration"]
        }
        let text = maskSensitive(visibleText(window))
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return ["captured": false, "reason": "text_unavailable"] }
        return ["captured": true, "app": app.localizedName ?? bundle, "bundleId": bundle,
                "title": maskSensitive(ax(window, kAXTitleAttribute) as? String ?? ""), "text": text,
                "capturedAt": ISO8601DateFormatter().string(from: Date())]
    }

    private static func visibleText(_ root: AXUIElement) -> String {
        var texts: [String] = []
        var seen = Set<String>()
        var nodes = 0
        var count = 0
        let deadline = Date().addingTimeInterval(0.5)
        func walk(_ element: AXUIElement, depth: Int) {
            guard depth < 12, nodes < 300, count < 12_000, Date() < deadline else { return }
            nodes += 1
            AXUIElementSetMessagingTimeout(element, 0.05)
            guard !isSecureTextField(ax(element, kAXSubroleAttribute) as? String) else { return }
            let role = ax(element, kAXRoleAttribute) as? String ?? ""
            if [kAXStaticTextRole, kAXTextAreaRole, kAXTextFieldRole].contains(role), let value = ax(element, kAXValueAttribute) as? String, !value.isEmpty, seen.insert(value).inserted {
                let clipped = String(value.prefix(12_000 - count))
                texts.append(clipped); count += clipped.count
            }
            let children = (ax(element, kAXVisibleChildrenAttribute) as? [AXUIElement]) ?? (ax(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
            for child in children { walk(child, depth: depth + 1) }
        }
        walk(root, depth: 0)
        return texts.joined(separator: "\n")
    }
}

func writingTargetMatches(originalValue: String, currentValue: String, originalRange: NSRange?, currentRange: NSRange?, originalSelection: String, currentSelection: String) -> Bool {
    originalValue == currentValue && originalRange == currentRange && originalSelection == currentSelection
}

func isBlockedApplication(_ bundle: String) -> Bool {
    let value = bundle.lowercased()
    return ["app.desktoppets.pace", "com.apple.passwords", "com.apple.keychainaccess", "com.apple.securityagent"].contains(value) || ["1password", "bitwarden", "lastpass", "dashlane", "keepass"].contains(where: value.contains)
}

func isSecureTextField(_ subrole: String?) -> Bool { subrole == kAXSecureTextFieldSubrole }

func maskSensitive(_ text: String) -> String {
    var result = text
    let patterns = [
        #"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"#,
        #"\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b"#,
        #"(?i)\b(?:api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*["']?[^\s"']{6,}"#,
        #"\b(?:\d[ -]*?){13,19}\b"#
    ]
    for pattern in patterns {
        guard let expression = try? NSRegularExpression(pattern: pattern) else { continue }
        result = expression.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: "[REDACTED]")
    }
    return result
}
