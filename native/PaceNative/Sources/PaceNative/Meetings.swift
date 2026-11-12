import AppKit
import AVFoundation
import CoreMedia
import ScreenCaptureKit

func waveData(_ pcm: Data, sampleRate: UInt32 = 16_000) -> Data {
    var data = Data()
    func ascii(_ value: String) { data.append(contentsOf: value.utf8) }
    func u16(_ value: UInt16) { var n = value.littleEndian; withUnsafeBytes(of: &n) { data.append(contentsOf: $0) } }
    func u32(_ value: UInt32) { var n = value.littleEndian; withUnsafeBytes(of: &n) { data.append(contentsOf: $0) } }
    ascii("RIFF"); u32(UInt32(pcm.count) + 36); ascii("WAVEfmt "); u32(16)
    u16(1); u16(1); u32(sampleRate); u32(sampleRate * 2); u16(2); u16(16)
    ascii("data"); u32(UInt32(pcm.count)); data.append(pcm)
    return data
}

final class AudioSink: @unchecked Sendable {
    let url: URL
    let track: String
    private let sessionId: String
    private let emit: ([String: Any]) -> Void
    private let lock = NSLock()
    private let file: FileHandle
    private let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!
    private var converter: AVAudioConverter?
    private var sourceFormat: AVAudioFormat?
    private var pending = Data()
    private var frames: Int64 = 0
    private var chunkStart: Int64 = 0
    private var closed = false
    private var failure: String?
    private var firstOffsetMs: Int?
    private let startDate: Date

    init(url: URL, sessionId: String, track: String, startDate: Date, emit: @escaping ([String: Any]) -> Void) throws {
        self.url = url; self.sessionId = sessionId; self.track = track; self.emit = emit; self.startDate = startDate
        try waveData(Data()).write(to: url, options: .atomic)
        file = try FileHandle(forUpdating: url)
        try file.seekToEnd()
    }

    func append(_ input: AVAudioPCMBuffer) {
        lock.lock(); defer { lock.unlock() }
        guard !closed, failure == nil, input.frameLength > 0 else { return }
        do {
            if firstOffsetMs == nil {
                firstOffsetMs = max(0, Int(Date().timeIntervalSince(startDate) * 1000 - Double(input.frameLength) / input.format.sampleRate * 1000))
            }
            if sourceFormat != input.format {
                try flushConverter()
                sourceFormat = input.format
                converter = AVAudioConverter(from: input.format, to: target)
            }
            guard let converter else { throw BridgeError("audio_format", "Unable to convert the audio input to 16 kHz mono.") }
            let capacity = AVAudioFrameCount(ceil(Double(input.frameLength) * 16_000 / input.format.sampleRate)) + 64
            guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { throw BridgeError("audio_buffer", "Unable to allocate an audio buffer.") }
            var provided = false
            var conversionError: NSError?
            let status = converter.convert(to: output, error: &conversionError) { _, inputStatus in
                if provided { inputStatus.pointee = .noDataNow; return nil }
                provided = true; inputStatus.pointee = .haveData; return input
            }
            if let conversionError { throw conversionError }
            guard status != .error, let bytes = output.int16ChannelData?[0] else {
                if status == .error { throw BridgeError("audio_conversion", "The audio converter failed.") }
                return
            }
            let pcm = Data(bytes: bytes, count: Int(output.frameLength) * 2)
            try appendPCM(pcm)
        } catch {
            failure = error.localizedDescription
            emit(["event": "audio.error", "data": ["sessionId": sessionId, "track": track, "message": error.localizedDescription]])
        }
    }

    // Kept separate so fixture tests exercise WAV/chunk boundaries without opening a microphone.
    func appendPCMForTesting(_ pcm: Data) throws {
        lock.lock(); defer { lock.unlock() }
        guard !closed, pcm.count.isMultiple(of: 2) else { throw BridgeError("audio_data", "Expected PCM16 audio.") }
        try appendPCM(pcm)
    }

    private func appendPCM(_ pcm: Data) throws {
        guard frames * 2 + Int64(pcm.count) < Int64(UInt32.max) - 44 else { throw BridgeError("recording_too_long", "Recording reached the WAV size limit.") }
        try file.write(contentsOf: pcm)
        frames += Int64(pcm.count / 2)
        pending.append(pcm)
        while pending.count >= 480_000 {
            let chunk = Data(pending.prefix(480_000))
            pending.removeFirst(480_000)
            try writeChunk(chunk)
        }
    }

    private func flushConverter() throws {
        guard let converter else { return }
        while true {
            guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: 4096) else { return }
            var conversionError: NSError?
            let status = converter.convert(to: output, error: &conversionError) { _, inputStatus in
                inputStatus.pointee = .endOfStream
                return nil
            }
            if let conversionError { throw conversionError }
            if output.frameLength > 0, let bytes = output.int16ChannelData?[0] {
                try appendPCM(Data(bytes: bytes, count: Int(output.frameLength) * 2))
            }
            if status == .endOfStream || output.frameLength == 0 { break }
            if status == .error { throw BridgeError("audio_conversion", "Unable to finalize audio conversion.") }
        }
        self.converter = nil
    }

    private func writeChunk(_ pcm: Data) throws {
        guard !pcm.isEmpty else { return }
        let path = url.deletingLastPathComponent().appendingPathComponent("\(track)-\(chunkStart).wav")
        try waveData(pcm).write(to: path, options: .atomic)
        if !closed { try updateHeader() }
        let end = chunkStart + Int64(pcm.count / 2)
        let offset = firstOffsetMs ?? 0
        emit(["event": "audio.chunk", "data": ["sessionId": sessionId, "track": track, "path": path.path,
              "startMs": offset + Int(chunkStart * 1000 / 16_000), "endMs": offset + Int(end * 1000 / 16_000)]])
        chunkStart = end
    }

    private func updateHeader() throws {
        try file.seek(toOffset: 0)
        var header = waveData(Data())
        var riffSize = UInt32(frames * 2 + 36).littleEndian
        var byteCount = UInt32(frames * 2).littleEndian
        withUnsafeBytes(of: &riffSize) { header.replaceSubrange(4..<8, with: $0) }
        withUnsafeBytes(of: &byteCount) { header.replaceSubrange(40..<44, with: $0) }
        try file.write(contentsOf: header)
        try file.seekToEnd()
        try file.synchronize()
    }

    func finish() throws -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        if !closed {
            do { try flushConverter() } catch { failure = error.localizedDescription }
            closed = true
            try updateHeader()
            try file.close()
            try writeChunk(pending)
            pending.removeAll()
        }
        var result: [String: Any] = ["path": url.path, "wavPath": url.path, "track": track, "durationMs": frames * 1000 / 16_000, "offsetMs": firstOffsetMs ?? 0, "frames": frames]
        if let failure { result["error"] = failure }
        return result
    }
}

final class MicrophoneCapture {
    private let engine = AVAudioEngine()
    let sink: AudioSink
    private var running = false

    init(sink: AudioSink) { self.sink = sink }

    func start() throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw BridgeError("microphone_unavailable", "No microphone input is available.") }
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { [sink] buffer, _ in sink.append(buffer) }
        do { try engine.start(); running = true }
        catch { input.removeTap(onBus: 0); throw error }
    }

    func stop() throws -> [String: Any] {
        if running { engine.inputNode.removeTap(onBus: 0); engine.stop(); running = false }
        return try sink.finish()
    }
}

final class SystemAudioCapture: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let sink: AudioSink
    private var stream: SCStream?
    private let queue = DispatchQueue(label: "desktop-pets.system-audio")
    private let emit: ([String: Any]) -> Void
    private let sessionId: String
    private let applicationBundleId: String?

    init(sink: AudioSink, sessionId: String, applicationBundleId: String?, emit: @escaping ([String: Any]) -> Void) {
        self.sink = sink; self.sessionId = sessionId; self.applicationBundleId = applicationBundleId; self.emit = emit
    }

    func start() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first else { throw BridgeError("display_unavailable", "No display is available for system audio capture.") }
        let filter: SCContentFilter
        if let applicationBundleId {
            guard let application = content.applications.first(where: { $0.bundleIdentifier == applicationBundleId }) else {
                throw BridgeError("meeting_app_unavailable", "The selected meeting application is not running or cannot be captured.")
            }
            filter = SCContentFilter(display: display, including: [application], exceptingWindows: [])
        } else {
            filter = SCContentFilter(display: display, excludingWindows: [])
        }
        let config = SCStreamConfiguration()
        config.width = 2; config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        config.queueDepth = 3
        config.capturesAudio = true
        config.sampleRate = 48_000
        config.channelCount = 2
        config.excludesCurrentProcessAudio = true
        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        self.stream = stream
        do { try await stream.startCapture() }
        catch { self.stream = nil; throw error }
    }

    func stop() async throws -> [String: Any] {
        var stopError: Error?
        if let stream { do { try await stream.stopCapture() } catch { stopError = error } }
        stream = nil
        // Drain samples already queued before closing the WAV.
        queue.sync {}
        var result = try sink.finish()
        if let stopError { result["error"] = stopError.localizedDescription }
        return result
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid, let description = sampleBuffer.formatDescription,
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(description),
              let format = AVAudioFormat(streamDescription: asbd) else { return }
        let count = AVAudioFrameCount(sampleBuffer.numSamples)
        guard count > 0, let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: count) else { return }
        pcm.frameLength = count
        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(sampleBuffer, at: 0, frameCount: Int32(count), into: pcm.mutableAudioBufferList)
        guard status == noErr else {
            emit(["event": "audio.error", "data": ["sessionId": sessionId, "track": "system", "message": "Unable to decode a system audio sample (\(status))."]])
            return
        }
        sink.append(pcm)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        emit(["event": "meeting.error", "data": ["sessionId": sessionId, "track": "system", "message": error.localizedDescription]])
    }
}

@MainActor
enum MeetingService {
    private static var microphone: MicrophoneCapture?
    private static var system: SystemAudioCapture?
    private static var sessionId: String?
    private static var startDate: Date?
    private static var dictation: MicrophoneCapture?
    private static var dictationId: String?
    private static var starting = false

    static func handle(method: String, params: [String: Any], emit: @escaping ([String: Any]) -> Void) async throws -> [String: Any]? {
        switch method {
        case "meeting.status": return status()
        case "meeting.start": return try await start(params, emit: emit)
        case "meeting.stop": return try await stop(emit: emit)
        case "audio.start":
            guard dictation == nil, sessionId == nil, !starting else { throw BridgeError("audio_busy", "Stop the active recording before starting dictation.") }
            starting = true; defer { starting = false }
            try await requireMicrophone()
            let id = UUID().uuidString
            let directory = try recordingDirectory(params, id: id)
            let sink = try AudioSink(url: directory.appendingPathComponent("dictation.wav"), sessionId: id, track: "dictation", startDate: Date(), emit: { _ in })
            let capture = MicrophoneCapture(sink: sink)
            do { try capture.start() } catch { _ = try? sink.finish(); throw error }
            dictation = capture; dictationId = id
            return ["recording": true, "sessionId": id]
        case "audio.stop":
            guard let capture = dictation else { throw BridgeError("not_recording", "Dictation is not recording.") }
            dictation = nil
            var result = try capture.stop()
            result["sessionId"] = dictationId
            dictationId = nil
            result["recording"] = false
            return result
        default: return nil
        }
    }

    private static func requireMicrophone() async throws {
        if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined { _ = await AVCaptureDevice.requestAccess(for: .audio) }
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else { throw BridgeError("permission_required", "Enable Microphone access in System Settings to record audio.") }
    }

    private static func recordingDirectory(_ params: [String: Any], id: String) throws -> URL {
        let root: URL
        if let path = params["outputDir"] as? String {
            guard path.hasPrefix("/") else { throw BridgeError("invalid_path", "The recording output directory must be an absolute path.") }
            root = URL(fileURLWithPath: path, isDirectory: true)
        } else {
            root = NativePaths.root.appendingPathComponent("recordings", isDirectory: true)
        }
        let directory = root.appendingPathComponent(id, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return directory
    }

    private static func start(_ params: [String: Any], emit: @escaping ([String: Any]) -> Void) async throws -> [String: Any] {
        guard sessionId == nil, dictation == nil, !starting else { throw BridgeError("audio_busy", "A recording is already active.") }
        starting = true; defer { starting = false }
        let captureMic = params["captureMicrophone"] as? Bool ?? true
        let captureSystem = params["captureSystem"] as? Bool ?? true
        let applicationBundleId = (params["applicationBundleId"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        guard captureMic || captureSystem else { throw BridgeError("no_audio_source", "Choose microphone or system audio for this meeting.") }
        if captureMic { try await requireMicrophone() }
        if captureSystem && !CGPreflightScreenCaptureAccess() {
            throw BridgeError("permission_required", "Enable Screen & System Audio Recording in System Settings before capturing meeting audio.")
        }
        let id = UUID().uuidString
        let date = Date()
        let directory = try recordingDirectory(params, id: id)
        var mic: MicrophoneCapture?
        var sys: SystemAudioCapture?
        do {
            if captureMic {
                let sink = try AudioSink(url: directory.appendingPathComponent("microphone.wav"), sessionId: id, track: "microphone", startDate: date, emit: emit)
                mic = MicrophoneCapture(sink: sink)
                try mic?.start()
            }
            if captureSystem {
                let sink = try AudioSink(url: directory.appendingPathComponent("system.wav"), sessionId: id, track: "system", startDate: date, emit: emit)
                sys = SystemAudioCapture(sink: sink, sessionId: id, applicationBundleId: applicationBundleId, emit: emit)
                try await sys?.start()
            }
        } catch {
            if let mic { _ = try? mic.stop() }
            if let sys { _ = try? await sys.stop() }
            throw error
        }
        microphone = mic; system = sys; sessionId = id; startDate = date
        let result: [String: Any] = ["recording": true, "sessionId": id, "startedAt": ISO8601DateFormatter().string(from: date), "directory": directory.path, "captureMicrophone": captureMic, "captureSystem": captureSystem,
                                   "systemAudioScope": applicationBundleId ?? "all-system-audio"]
        emit(["event": "meeting.started", "data": result])
        return result
    }

    private static func stop(emit: @escaping ([String: Any]) -> Void) async throws -> [String: Any] {
        guard let id = sessionId else { throw BridgeError("not_recording", "No meeting is recording.") }
        let mic = microphone; let sys = system; let date = startDate
        microphone = nil; system = nil; sessionId = nil; startDate = nil
        var tracks: [[String: Any]] = []
        if let mic {
            do { tracks.append(try mic.stop()) }
            catch { tracks.append(["track": "microphone", "path": mic.sink.url.path, "error": error.localizedDescription]) }
        }
        if let sys {
            do { tracks.append(try await sys.stop()) }
            catch { tracks.append(["track": "system", "path": sys.sink.url.path, "error": error.localizedDescription]) }
        }
        let result: [String: Any] = ["recording": false, "sessionId": id, "tracks": tracks, "durationMs": Int(Date().timeIntervalSince(date ?? Date()) * 1000)]
        emit(["event": "meeting.stopped", "data": result])
        return result
    }

    private static func status() -> [String: Any] {
        var result: [String: Any] = ["recording": sessionId != nil, "starting": starting, "dictating": dictation != nil]
        if let sessionId { result["sessionId"] = sessionId }
        if let startDate { result["startedAt"] = ISO8601DateFormatter().string(from: startDate) }
        return result
    }
}
