import Foundation
import Darwin
import AppKit

final class JSONOutput: @unchecked Sendable {
    static let shared = JSONOutput()
    private let lock = NSLock()
    private let handle: FileHandle
    private init() {
        handle = FileHandle(fileDescriptor: dup(STDOUT_FILENO), closeOnDealloc: true)
        // Libraries occasionally print diagnostics; reserve stdout exclusively for JSONL.
        dup2(STDERR_FILENO, STDOUT_FILENO)
    }
    func send(_ object: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(object), let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
        lock.lock(); defer { lock.unlock() }
        handle.write(data); handle.write(Data([10]))
    }
}

final class RequestTasks: @unchecked Sendable {
    static let shared = RequestTasks()
    private let lock = NSLock()
    private var tasks: [String: (String, Task<Void, Never>)] = [:]
    func start(id: String, method: String, operation: @escaping () async -> Void) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard tasks[id] == nil else { return false }
        let task = Task.detached { await operation(); self.remove(id) }
        tasks[id] = (method, task)
        return true
    }
    func remove(_ id: String) { lock.lock(); defer { lock.unlock() }; tasks.removeValue(forKey: id) }
    func cancel(id: String? = nil, method: String? = nil) -> Int {
        lock.lock(); defer { lock.unlock() }
        let selected = tasks.filter { key, value in
            if let id { return key == id }
            if let method { return value.0 == method }
            return ["chat.generate", "voice.speak", "audio.transcribe", "audio.diarize", "models.install"].contains(value.0)
        }
        for entry in selected.values { entry.1.cancel() }
        return selected.count
    }
    var count: Int { lock.lock(); defer { lock.unlock() }; return tasks.count }
}

enum NativeWorker {
    static func handle(method: String, params: [String: Any], emit: @escaping Emit) async throws -> Any {
        switch method {
        case "models.status": return await ModelStore.shared.status()
        case "models.install":
            guard let id = params["id"] as? String ?? params["model"] as? String else { throw WorkerError("invalid_params", "Provide the model id.") }
            return try await ModelStore.shared.install(id: id, emit: emit)
        case "chat.generate": return try await InferenceService.shared.chat(params: params, emit: emit)
        case "voice.speak": return try await InferenceService.shared.speak(params: params, emit: emit)
        case "voice.stop":
            _ = RequestTasks.shared.cancel(method: "voice.speak")
            await VoicePlayback.shared.stop()
            await InferenceService.shared.releaseVoice()
            return ["stopped": true]
        case "runtime.releaseVoice":
            _ = RequestTasks.shared.cancel(method: "voice.speak")
            await VoicePlayback.shared.stop()
            await InferenceService.shared.releaseVoice()
            return ["released": true]
        case "audio.transcribe": return try await TranscriptionService.shared.transcribe(params: params)
        case "runtime.status":
            var status = await InferenceService.shared.status()
            status["dataDirectory"] = NativePaths.root.path
            status["whisperAvailable"] = (try? TranscriptionService.executable()) != nil
            return status
        case "runtime.cancel": return ["cancelled": RequestTasks.shared.cancel(id: params["id"] as? String ?? params["requestId"] as? String)]
        default:
            if let result = try await BridgeService.handle(method: method, params: params, emit: emit) { return result }
            throw WorkerError("unknown_method", "Unknown native method: \(method)")
        }
    }
    static func run() async {
        let output = JSONOutput.shared
        output.send(["event": "runtime.ready", "data": ["protocolVersion": 1]])
        await withCheckedContinuation { (finished: CheckedContinuation<Void, Never>) in
            DispatchQueue.global(qos: .userInitiated).async {
                while let line = readLine() {
                    do {
                        guard line.utf8.count <= 1_048_576, let raw = line.data(using: .utf8),
                              let request = try JSONSerialization.jsonObject(with: raw) as? [String: Any],
                              let id = request["id"] as? String, !id.isEmpty, id.count <= 128,
                              let method = request["method"] as? String else { throw WorkerError("invalid_request", "Expected {id, method, params} JSON.") }
                        let params = request["params"] as? [String: Any] ?? [:]
                        let started = RequestTasks.shared.start(id: id, method: method) {
                            let emit: Emit = { event in
                                var value = event
                                var data = event["data"] as? [String: Any] ?? [:]
                                data["requestId"] = id; value["data"] = data
                                output.send(value)
                            }
                            do { output.send(["id": id, "result": try await handle(method: method, params: params, emit: emit)]) }
                            catch {
                                let code = (error as? WorkerError)?.code ?? (error as? BridgeError)?.code ?? (error is CancellationError ? "cancelled" : "native_error")
                                output.send(["id": id, "error": ["code": code, "message": error.localizedDescription]])
                            }
                        }
                        if !started { output.send(["id": id, "error": ["code": "duplicate_id", "message": "This request id is already active."]]) }
                    } catch { output.send(["event": "runtime.error", "data": ["message": error.localizedDescription]]) }
                }
                finished.resume()
            }
        }
        while RequestTasks.shared.count > 0 { try? await Task.sleep(nanoseconds: 50_000_000) }
    }
}

_ = JSONOutput.shared
let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
// AppKit refreshes workspace and running-app state only while the Cocoa run loop runs.
Task {
    await NativeWorker.run()
    exit(0)
}
application.run()
