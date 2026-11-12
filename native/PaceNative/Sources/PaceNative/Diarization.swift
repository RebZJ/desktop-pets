import Foundation

func parseDiarizationSegments(_ data: Data) throws -> [[String: Any]] {
    let json = try JSONSerialization.jsonObject(with: data)
    let raw: [[String: Any]]
    if let object = json as? [String: Any], let segments = object["segments"] as? [[String: Any]] { raw = segments }
    else if let segments = json as? [[String: Any]] { raw = segments }
    else { throw BridgeError("invalid_diarization", "The diarizer returned an unsupported response.") }
    return try raw.map { segment in
        guard let start = segment["start"] as? NSNumber, let end = segment["end"] as? NSNumber,
              let speaker = segment["speaker"] as? NSNumber, start.doubleValue.isFinite, end.doubleValue.isFinite,
              start.doubleValue >= 0, end.doubleValue >= start.doubleValue, end.doubleValue < Double(Int.max) / 1000,
              speaker.intValue >= 1, speaker.intValue <= 8, speaker.doubleValue == Double(speaker.intValue) else {
            throw BridgeError("invalid_diarization", "The diarizer returned an invalid speaker segment.")
        }
        return ["start": start.doubleValue, "end": end.doubleValue, "speaker": speaker.intValue,
                "startMs": Int((start.doubleValue * 1000).rounded()), "endMs": Int((end.doubleValue * 1000).rounded())]
    }
}

@MainActor
enum DiarizationService {
    private static var active: Process?

    static func handle(method: String, params: [String: Any], emit: @escaping ([String: Any]) -> Void) async throws -> [String: Any]? {
        if method == "audio.diarize.cancel" {
            if let active, active.isRunning { active.terminate() }
            return ["cancelled": true]
        }
        guard method == "audio.diarize" else { return nil }
        guard active == nil else { throw BridgeError("diarization_busy", "Speaker recognition is already running.") }
        guard let path = params["path"] as? String, path.hasPrefix("/"), FileManager.default.fileExists(atPath: path) else {
            throw BridgeError("invalid_audio", "Choose an existing local WAV file for speaker recognition.")
        }
        let model = try ModelStore.require("nemotron-diarization")
        let modelPath = model.directory.appendingPathComponent("Nemotron-3-Diarization.q8_0.gguf").path
        let environment = ProcessInfo.processInfo.environment
        let binDirectory = environment["PACE_BIN_DIR"] ?? URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("native/bin").path
        let executable = environment["PACE_DIARIZE_BIN"] ?? URL(fileURLWithPath: binDirectory).appendingPathComponent("nemo-speech").path
        guard FileManager.default.isExecutableFile(atPath: executable) else { throw BridgeError("diarizer_missing", "The native diarizer is missing. Run npm run native:diarization before building the app.") }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("pace-diarization-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: directory) }
        let output = directory.appendingPathComponent("segments.json")
        let diagnostics = directory.appendingPathComponent("diagnostics.log")
        FileManager.default.createFile(atPath: diagnostics.path, contents: Data())
        let errorFile = try FileHandle(forWritingTo: diagnostics)
        defer { try? errorFile.close() }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = ["diarize", path, "--model", modelPath, "--format", "json", "--output", output.path]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = errorFile
        active = process
        defer { active = nil }
        emit(["event": "diarization.started", "data": ["path": path]])
        let status: Int32 = try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                process.terminationHandler = { process in continuation.resume(returning: process.terminationStatus) }
                do { try process.run() } catch { continuation.resume(throwing: error) }
            }
        }, onCancel: {
            if process.isRunning { process.terminate() }
        })
        try Task.checkCancellation()
        guard status == 0 else {
            let detail = (try? String(contentsOf: diagnostics, encoding: .utf8)) ?? ""
            throw BridgeError("diarization_failed", "Speaker recognition failed. \(String(detail.suffix(2000)))")
        }
        let segments = try parseDiarizationSegments(Data(contentsOf: output))
        emit(["event": "diarization.completed", "data": ["path": path, "segmentCount": segments.count]])
        return ["segments": segments, "model": "nemotron-diarization", "speakerCount": Set(segments.compactMap { $0["speaker"] as? Int }).count]
    }
}
