// The macOS-only AX / ScreenCaptureKit adapter. Inference and normal audio capture live in Rust.
import AppKit
import Foundation
import Darwin

enum NativePaths {
    static var root: URL {
        if let path = ProcessInfo.processInfo.environment["PACE_DATA_DIR"] {
            return URL(fileURLWithPath: path, isDirectory: true)
        }
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Desktop Pets", isDirectory: true)
    }
}

final class PlatformOutput: @unchecked Sendable {
    static let shared = PlatformOutput()
    private let lock = NSLock()
    private let handle = FileHandle(fileDescriptor: dup(STDOUT_FILENO), closeOnDealloc: true)
    private init() { dup2(STDERR_FILENO, STDOUT_FILENO) }
    func send(_ value: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(value), let data = try? JSONSerialization.data(withJSONObject: value) else { return }
        lock.lock(); defer { lock.unlock() }
        try? handle.write(contentsOf: data)
        try? handle.write(contentsOf: Data([10]))
    }
}

enum PlatformWorker {
    static func handle(_ method: String, _ params: [String: Any], emit: @escaping ([String: Any]) -> Void) async throws -> [String: Any] {
        if method == "runtime.cancel" {
            let id = params["id"] as? String ?? params["requestId"] as? String
            let cancelled = RequestTasks.shared.cancel(id: id)
            if let id { await MeetingService.cancelCapture(requestId: id) }
            return ["cancelled": cancelled]
        }
        if method == "voice.stop" || method == "runtime.releaseVoice" { return ["stopped": true, "released": true] }
        let methods: Set<String> = ["permissions.status", "permissions.request", "apps.list", "dictation.capture", "dictation.insert", "dictation.discard", "meeting.start", "meeting.stop", "meeting.status"]
        guard methods.contains(method) else { throw BridgeError("unsupported", "This macOS helper provides dictation insertion and scoped meeting capture only.") }
        guard let result = try await BridgeService.handle(method: method, params: params, emit: emit) else {
            throw BridgeError("unsupported", "This macOS operation is unavailable.")
        }
        return result
    }

    static func run() async {
        let output = PlatformOutput.shared
        output.send(["event": "runtime.ready", "data": ["protocolVersion": 1, "backend": "macOS platform adapter"]])
        await withCheckedContinuation { (finished: CheckedContinuation<Void, Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                while let line = readLine() {
                    do {
                        guard line.utf8.count <= 1_048_576, let raw = line.data(using: .utf8),
                              let request = try JSONSerialization.jsonObject(with: raw) as? [String: Any],
                              let id = request["id"] as? String, !id.isEmpty, id.utf8.count <= 128,
                              let method = request["method"] as? String else {
                            throw BridgeError("invalid_request", "Expected {id, method, params} JSON.")
                        }
                        let params = (request["params"] as? [String: Any] ?? [:]).merging(["_requestId": id]) { _, value in value }
                        let started = RequestTasks.shared.start(id: id, method: method) {
                            do {
                                let result = try await handle(method, params) { event in
                                    var event = event
                                    var data = event["data"] as? [String: Any] ?? [:]
                                    data["requestId"] = id; event["data"] = data
                                    output.send(event)
                                }
                                output.send(["id": id, "result": result])
                            } catch {
                                output.send(["id": id, "error": ["code": (error as? BridgeError)?.code ?? (error is CancellationError ? "cancelled" : "platform_error"), "message": error.localizedDescription]])
                            }
                        }
                        if !started { output.send(["id": id, "error": ["code": "duplicate_id", "message": "This request id is already active."]]) }
                    } catch { output.send(["event": "runtime.error", "data": ["message": error.localizedDescription]]) }
                }
                RequestTasks.shared.shutdown()
                finished.resume()
            }
        }
        await MeetingService.shutdown()
    }
}

signal(SIGPIPE, SIG_IGN)
_ = PlatformOutput.shared
let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
Task { await PlatformWorker.run(); exit(0) }
application.run()
