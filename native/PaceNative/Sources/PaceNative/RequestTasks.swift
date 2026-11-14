import Foundation

final class RequestTasks: @unchecked Sendable {
    static let shared = RequestTasks()
    private let lock = NSLock()
    private var closed = false
    private var speechEpoch: UInt64 = 0
    private var tasks: [String: (String, Task<Void, Never>)] = [:]
    func start(id: String, method: String, operation: @escaping () async -> Void) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !closed, tasks[id] == nil else { return false }
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
    func shutdown() {
        lock.lock(); defer { lock.unlock() }
        closed = true
        for (_, task) in tasks.values { task.cancel() }
    }
    func advanceSpeechEpoch(_ epoch: UInt64) {
        lock.lock(); defer { lock.unlock() }
        speechEpoch = max(speechEpoch, epoch)
    }
    func acceptAutomaticSpeech(_ epoch: UInt64) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard epoch >= speechEpoch else { return false }
        speechEpoch = epoch
        return true
    }
    var count: Int { lock.lock(); defer { lock.unlock() }; return tasks.count }
}


func capturePermission(_ request: () async -> Bool) async throws -> Bool {
    try Task.checkCancellation()
    let allowed = await request()
    try Task.checkCancellation()
    return allowed
}
