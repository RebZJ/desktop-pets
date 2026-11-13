import XCTest
@testable import PaceNative

final class DictationRuntimeTests: XCTestCase {
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
