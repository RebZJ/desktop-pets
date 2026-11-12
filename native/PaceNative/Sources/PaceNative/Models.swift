import Foundation
import CryptoKit

struct WorkerError: LocalizedError {
    let code: String
    let message: String
    var errorDescription: String? { message }
    init(_ code: String, _ message: String) { self.code = code; self.message = message }
}

typealias Emit = ([String: Any]) -> Void

enum NativePaths {
    static var root: URL {
        if let override = ProcessInfo.processInfo.environment["PACE_DATA_DIR"] { return URL(fileURLWithPath: override, isDirectory: true) }
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Desktop Pets", isDirectory: true)
    }
    static var models: URL {
        if let override = ProcessInfo.processInfo.environment["PACE_MODELS_DIR"] { return URL(fileURLWithPath: override, isDirectory: true) }
        return root.appendingPathComponent("models", isDirectory: true)
    }
    static var generated: URL { root.appendingPathComponent("generated", isDirectory: true) }
}

struct ModelDefinition {
    let id: String
    let name: String
    let role: String
    let repo: String
    let sizeBytes: Int64
    var singleFile: String? = nil
    var supplementalFiles: [ModelFile] = []
    static let all = [
        ModelDefinition(id: "qwen3.5-4b", name: "Qwen 3.5 4B · 4-bit", role: "chat", repo: "mlx-community/Qwen3.5-4B-4bit", sizeBytes: 3_061_000_000),
        ModelDefinition(id: "qwen3-tts-0.6b", name: "Qwen 3 TTS · 0.6B · 8-bit", role: "voice", repo: "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit", sizeBytes: 1_970_000_000),
        ModelDefinition(id: "whisper-turbo", name: "Whisper large-v3-turbo · Q5_0 + Silero VAD", role: "transcription", repo: "ggerganov/whisper.cpp", sizeBytes: 574_926_293, singleFile: "ggml-large-v3-turbo-q5_0.bin", supplementalFiles: [SileroVAD.file]),
        ModelDefinition(id: "nemotron-diarization", name: "Nemotron 3 Diarization · Q8", role: "diarization", repo: "nvidia/Nemotron-3-Diarization", sizeBytes: 107_012_128, singleFile: "Nemotron-3-Diarization.q8_0.gguf"),
    ]
    var directory: URL { NativePaths.models.appendingPathComponent(id, isDirectory: true) }
    static func find(_ id: String) throws -> ModelDefinition {
        let canonical = id == "nemotron-3-diarization" ? "nemotron-diarization" : id
        guard let model = all.first(where: { $0.id == canonical || $0.repo == canonical }) else { throw WorkerError("unknown_model", "Unknown model: \(id)") }
        return model
    }
}

struct ModelFile: Codable {
    let path: String
    let size: Int64
    let sha256: String?
    let gitBlob: String?
    var sourceURL: String? = nil
}

enum SileroVAD {
    static let filename = "ggml-silero-v6.2.0.bin"
    static let file = ModelFile(path: filename, size: 885_098,
                               sha256: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987", gitBlob: nil,
                               sourceURL: "https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin")
}

struct ModelManifest: Codable {
    let repository: String
    let revision: String
    let files: [ModelFile]
}

actor ModelStore {
    static let shared = ModelStore()
    private var installing = Set<String>()
    private var progress: [String: Double] = [:]

    func status() -> [[String: Any]] {
        ModelDefinition.all.map { model in
            let installed = Self.isInstalled(model)
            return ["id": model.id, "name": model.name, "role": model.role, "sizeBytes": model.sizeBytes,
                    "installed": installed, "progress": installed ? 1 : (progress[model.id] ?? 0),
                    "status": installing.contains(model.id) ? "downloading" : (installed ? "installed" : "not-installed")]
        }
    }

    static func isInstalled(_ model: ModelDefinition) -> Bool {
        let marker = model.directory.appendingPathComponent(".installed.json")
        guard let data = try? Data(contentsOf: marker), let manifest = try? JSONDecoder().decode(ModelManifest.self, from: data) else { return false }
        return manifestIncludesSupplements(manifest, model: model) && !manifest.files.isEmpty && manifest.files.allSatisfy { file in
            let attrs = try? FileManager.default.attributesOfItem(atPath: model.directory.appendingPathComponent(file.path).path)
            return (attrs?[.size] as? NSNumber)?.int64Value == file.size
        }
    }

    static func manifestIncludesSupplements(_ manifest: ModelManifest, model: ModelDefinition) -> Bool {
        model.supplementalFiles.allSatisfy { required in manifest.files.contains(where: { $0.path == required.path && $0.sha256 == required.sha256 && $0.size == required.size }) }
    }

    static func addingSupplements(to manifest: ModelManifest, model: ModelDefinition) -> ModelManifest {
        let requiredPaths = Set(model.supplementalFiles.map(\.path))
        return ModelManifest(repository: manifest.repository, revision: manifest.revision,
                             files: manifest.files.filter { !requiredPaths.contains($0.path) } + model.supplementalFiles)
    }

    static func require(_ id: String) throws -> ModelDefinition {
        let model = try ModelDefinition.find(id)
        guard isInstalled(model) else { throw WorkerError("model_not_installed", "Install \(model.name) from Settings first.") }
        return model
    }

    func install(id: String, emit: @escaping Emit) async throws -> [String: Any] {
        let model = try ModelDefinition.find(id)
        guard !installing.contains(model.id) else { throw WorkerError("busy", "This model is already downloading.") }
        if Self.isInstalled(model) { return ["id": model.id, "installed": true] }
        installing.insert(model.id)
        defer { installing.remove(model.id) }
        try FileManager.default.createDirectory(at: model.directory, withIntermediateDirectories: true)
        let manifestURL = model.directory.appendingPathComponent(".download.json")
        let manifest: ModelManifest
        if let data = try? Data(contentsOf: manifestURL), let saved = try? JSONDecoder().decode(ModelManifest.self, from: data) {
            manifest = Self.addingSupplements(to: saved, model: model)
            try JSONEncoder().encode(manifest).write(to: manifestURL, options: .atomic)
        } else {
            manifest = try await Self.fetchManifest(model)
            try JSONEncoder().encode(manifest).write(to: manifestURL, options: .atomic)
        }
        let total = manifest.files.reduce(Int64(0)) { $0 + $1.size }
        var completed: Int64 = 0
        for file in manifest.files {
            try Task.checkCancellation()
            guard Self.safeRelativePath(file.path) else { throw WorkerError("invalid_manifest", "Unsafe model file path.") }
            let destination = model.directory.appendingPathComponent(file.path)
            try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
            if FileManager.default.fileExists(atPath: destination.path), try Self.verify(destination, file: file) {
                completed += file.size
                continue
            }
            let partial = destination.appendingPathExtension("partial")
            if FileManager.default.fileExists(atPath: partial.path), try Self.verify(partial, file: file) {
                if FileManager.default.fileExists(atPath: destination.path) { try FileManager.default.removeItem(at: destination) }
                try FileManager.default.moveItem(at: partial, to: destination)
                completed += file.size
                continue
            }
            let escaped = file.path.split(separator: "/").map { String($0).addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)! }.joined(separator: "/")
            let url = file.sourceURL ?? "https://huggingface.co/\(manifest.repository)/resolve/\(manifest.revision)/\(escaped)"
            guard URL(string: url)?.scheme == "https", URL(string: url)?.host == "huggingface.co" else { throw WorkerError("invalid_manifest", "Model files must use the configured HTTPS model host.") }
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
            process.arguments = ["--fail", "--location", "--silent", "--show-error", "--retry", "3", "--continue-at", "-", "--output", partial.path, url]
            let errorPipe = Pipe(); process.standardError = errorPipe; process.standardOutput = FileHandle.nullDevice
            try process.run()
            do {
                while process.isRunning {
                    try Task.checkCancellation()
                    let bytes = ((try? FileManager.default.attributesOfItem(atPath: partial.path)[.size]) as? NSNumber)?.int64Value ?? 0
                    let fraction = min(1, Double(completed + bytes) / Double(max(1, total)))
                    progress[model.id] = fraction
                    emit(["event": "models.progress", "data": ["id": model.id, "progress": fraction, "downloadedBytes": completed + bytes, "totalBytes": total, "file": file.path]])
                    try await Task.sleep(nanoseconds: 300_000_000)
                }
            } catch {
                if process.isRunning { process.terminate() }
                throw error
            }
            let diagnostic = String(data: errorPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "Download failed."
            guard process.terminationStatus == 0 else { throw WorkerError("download_failed", diagnostic) }
            guard try Self.verify(partial, file: file) else {
                try? FileManager.default.removeItem(at: partial)
                throw WorkerError("checksum_failed", "Checksum failed for \(file.path). Retry the download.")
            }
            if FileManager.default.fileExists(atPath: destination.path) { try FileManager.default.removeItem(at: destination) }
            try FileManager.default.moveItem(at: partial, to: destination)
            completed += file.size
        }
        try JSONEncoder().encode(manifest).write(to: model.directory.appendingPathComponent(".installed.json"), options: .atomic)
        progress[model.id] = 1
        emit(["event": "models.progress", "data": ["id": model.id, "progress": 1.0, "installed": true]])
        return ["id": model.id, "installed": true, "revision": manifest.revision]
    }

    static func safeRelativePath(_ path: String) -> Bool {
        !path.isEmpty && !path.hasPrefix("/") && !path.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0 == ".." || $0 == "." || $0.isEmpty })
    }

    static func verify(_ url: URL, file: ModelFile) throws -> Bool {
        guard let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? NSNumber, size.int64Value == file.size else { return false }
        let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
        if let expected = file.sha256 {
            var hasher = SHA256()
            while let chunk = try handle.read(upToCount: 1_048_576), !chunk.isEmpty { hasher.update(data: chunk) }
            return hasher.finalize().map { String(format: "%02x", $0) }.joined() == expected
        }
        if let expected = file.gitBlob {
            var hasher = Insecure.SHA1()
            hasher.update(data: Data("blob \(file.size)\0".utf8))
            while let chunk = try handle.read(upToCount: 1_048_576), !chunk.isEmpty { hasher.update(data: chunk) }
            return hasher.finalize().map { String(format: "%02x", $0) }.joined() == expected
        }
        return false
    }

    private static func json(_ url: String) async throws -> Any {
        // curl shares the downloader's proxy support, including managed desktop environments.
        let data = try await Task.detached {
            let process = Process(); let output = Pipe()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
            process.arguments = ["--fail", "--location", "--silent", "--show-error", "--connect-timeout", "20", "--max-time", "60", url]
            process.standardOutput = output; process.standardError = FileHandle.standardError
            try process.run()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { throw WorkerError("download_failed", "Cannot read model metadata. Check your internet connection and retry.") }
            return data
        }.value
        return try JSONSerialization.jsonObject(with: data)
    }

    private static func fetchManifest(_ model: ModelDefinition) async throws -> ModelManifest {
        guard let info = try await json("https://huggingface.co/api/models/\(model.repo)") as? [String: Any], let revision = info["sha"] as? String else { throw WorkerError("invalid_manifest", "Missing model revision.") }
        let tree = try await json("https://huggingface.co/api/models/\(model.repo)/tree/\(revision)?recursive=true&blobs=true") as? [[String: Any]] ?? []
        let files = tree.compactMap { item -> ModelFile? in
            guard item["type"] as? String == "file", let path = item["path"] as? String, let size = item["size"] as? Int64 else { return nil }
            if let only = model.singleFile { guard path == only else { return nil } }
            else { guard !path.hasPrefix("."), !path.hasSuffix(".md"), !path.hasSuffix(".py") else { return nil } }
            let lfs = item["lfs"] as? [String: Any]
            return ModelFile(path: path, size: size, sha256: lfs?["oid"] as? String, gitBlob: lfs == nil ? item["oid"] as? String : nil)
        }
        guard !files.isEmpty else { throw WorkerError("invalid_manifest", "No model files were found.") }
        return addingSupplements(to: ModelManifest(repository: model.repo, revision: revision, files: files), model: model)
    }
}
