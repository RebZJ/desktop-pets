import XCTest
import AVFoundation
@testable import PaceNative

final class DictationRuntimeTests: XCTestCase {
    func testRecordingRetainsEarlySpeechWhileTheTinyModelPrepares() async throws {
        guard let path = ProcessInfo.processInfo.environment["PACE_DICTATION_FIXTURE"] else {
            throw XCTSkip("Set PACE_DICTATION_FIXTURE to test recording buffers during installed Moonshine preparation.")
        }
        let service = TranscriptionService()
        let audio = try AVAudioFile(forReading: URL(fileURLWithPath: path), commonFormat: .pcmFormatInt16, interleaved: true)
        let pcm = try TranscriptionService.readWindow(audio, window: .init(startFrame: 0, endFrame: audio.length, coreStartFrame: 0, coreEndFrame: audio.length))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("dictation-preparation-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let output = directory.appendingPathComponent("dictation.wav")
        let bufferingStarted = Date()
        let sink = try AudioSink(url: output, sessionId: "early-speech", track: "dictation", startDate: Date(), emit: { _ in })
        let firstSecond = min(32_000, pcm.count)
        try sink.appendPCMForTesting(Data(pcm.prefix(firstSecond)))
        let preparation = Task { try await service.prepareDictation(language: "en") }
        for start in stride(from: firstSecond, to: pcm.count, by: 4096) {
            try sink.appendPCMForTesting(Data(pcm[start..<min(start + 4096, pcm.count)]))
        }
        let recording = try sink.finish()
        let bufferingMs = Date().timeIntervalSince(bufferingStarted) * 1000
        XCTAssertEqual(recording["frames"] as? Int64, Int64(pcm.count / 2))
        XCTAssertEqual(Data(try Data(contentsOf: output).dropFirst(44)), pcm)
        XCTAssertNoThrow(try sink.finish())
        let prepared = try await preparation.value
        XCTAssertEqual(prepared?["cold"] as? Bool, true)
        let transcript = try await service.transcribe(params: ["path": output.path, "purpose": "dictation", "language": "en"])
        XCTAssertEqual(transcript["cold"] as? Bool, false)
        XCTAssertTrue((transcript["text"] as? String ?? "").lowercased().contains("it was the best of times"))
        print("Buffered \(pcm.count / 2) frames in \(bufferingMs) ms without waiting for Moonshine; cold preparation \(prepared?["loadMs"] ?? "unknown") ms; prepared decode \(transcript["transcriptionMs"] ?? "unknown") ms")
    }

    func testOfflineDictationsKeepTheirAudioAndVocabularySeparate() async throws {
        guard let path = ProcessInfo.processInfo.environment["PACE_DICTATION_FIXTURE"] else {
            throw XCTSkip("Set PACE_DICTATION_FIXTURE to the official short human WAV to test installed Moonshine weights.")
        }
        let params: [String: Any] = ["path": path, "purpose": "dictation", "language": "en", "dictationVocabulary": ""]
        let first = try await TranscriptionService.shared.transcribe(params: params)
        let second = try await TranscriptionService.shared.transcribe(params: params)
        XCTAssertEqual(first["model"] as? String, "moonshine-tiny-en")
        XCTAssertEqual(first["text"] as? String, second["text"] as? String)
        XCTAssertTrue((first["text"] as? String ?? "").lowercased().contains("it was the best of times"))
        let silence = FileManager.default.temporaryDirectory.appendingPathComponent("dictation-silence-\(UUID().uuidString).wav")
        defer { try? FileManager.default.removeItem(at: silence) }
        try waveData(Data(repeating: 0, count: 16_000 * 2 * 3)).write(to: silence)
        let empty = try await TranscriptionService.shared.transcribe(params: ["path": silence.path, "purpose": "dictation", "language": "en", "dictationVocabulary": "Anushka Sharma"])
        XCTAssertEqual(empty["text"] as? String, "")
        XCTAssertEqual((empty["segments"] as? [[String: Any]])?.count, 0)
    }
}
