import XCTest
import AVFoundation
import ApplicationServices
@testable import PaceNative

final class BridgeTests: XCTestCase {
    func testDictationPreflightRequiresTheMatchingPackOrWhisperWithoutLoadingWeights() {
        XCTAssertNil(MoonshineBundle.availableModel(for: "en", isInstalled: { _ in false }))
        XCTAssertEqual(MoonshineBundle.availableModel(for: "en-AU", isInstalled: { $0.id == "moonshine-tiny-en" })?.id, "moonshine-tiny-en")
        XCTAssertNil(MoonshineBundle.availableModel(for: "ja", isInstalled: { $0.id == "moonshine-tiny-en" }))
        XCTAssertEqual(MoonshineBundle.availableModel(for: "ja", isInstalled: { $0.id == "whisper-turbo" })?.id, "whisper-turbo")
        XCTAssertEqual(MoonshineBundle.availableModel(for: "auto", isInstalled: { _ in true })?.id, "whisper-turbo")
    }

    func testWAVHeaderDescribesPCM16Mono() {
        let pcm = Data(repeating: 0, count: 32_000)
        let wav = waveData(pcm)
        XCTAssertEqual(wav.count, 32_044)
        XCTAssertEqual(String(data: wav.prefix(4), encoding: .ascii), "RIFF")
        XCTAssertEqual(Array(wav[22..<24]), [1, 0])
        XCTAssertEqual(Array(wav[24..<28]), [128, 62, 0, 0])
        XCTAssertEqual(Array(wav[34..<36]), [16, 0])
        XCTAssertEqual(Array(wav[40..<44]), [0, 125, 0, 0])
    }

    func testChunksAndFinalWAVHaveExactFrameCounts() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        var events: [[String: Any]] = []
        let sink = try AudioSink(url: folder.appendingPathComponent("microphone.wav"), sessionId: "fixture", track: "microphone", startDate: Date(), emit: { events.append($0) })
        try sink.appendPCMForTesting(Data(repeating: 0, count: 960_100))
        let result = try sink.finish()
        XCTAssertEqual(result["frames"] as? Int64, 480_050)
        XCTAssertEqual(events.count, 3)
        let chunks = events.compactMap { $0["data"] as? [String: Any] }
        XCTAssertEqual(chunks[0]["startMs"] as? Int, 0)
        XCTAssertEqual(chunks[0]["endMs"] as? Int, 15_000)
        XCTAssertEqual(chunks[1]["endMs"] as? Int, 30_000)
        XCTAssertEqual(chunks[2]["endMs"] as? Int, 30_003)
        XCTAssertEqual(try Data(contentsOf: folder.appendingPathComponent("microphone.wav")).count, 960_144)
        for chunk in chunks {
            let wav = try Data(contentsOf: URL(fileURLWithPath: chunk["path"] as! String))
            XCTAssertGreaterThan(wav.count, 44)
            XCTAssertEqual(String(data: wav[8..<12], encoding: .ascii), "WAVE")
        }
        XCTAssertNoThrow(try sink.finish())
    }

    func testActualFloatStereoResamplingProducesPCM16() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 2, interleaved: false)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4800)!
        buffer.frameLength = 4800
        for channel in 0..<2 {
            for frame in 0..<4800 { buffer.floatChannelData![channel][frame] = Float(sin(Double(frame) * 2 * .pi * 440 / 48_000)) * 0.3 }
        }
        let sink = try AudioSink(url: folder.appendingPathComponent("converted.wav"), sessionId: "fixture", track: "system", startDate: Date(), emit: { _ in })
        sink.append(buffer)
        let result = try sink.finish()
        XCTAssertNil(result["error"])
        let frames = try XCTUnwrap(result["frames"] as? Int64)
        XCTAssertEqual(frames, 1600)
        let wav = try Data(contentsOf: folder.appendingPathComponent("converted.wav"))
        XCTAssertTrue(wav.dropFirst(44).contains(where: { $0 != 0 }))
    }

    func testMaskingDoesNotRemoveOrdinaryContext() {
        XCTAssertEqual(maskSensitive("Pace likes the project meeting"), "Pace likes the project meeting")
        XCTAssertFalse(maskSensitive("password = hunter22\napi_key: sk-abcdefghijklmnopqrstuvwxyz123456").contains("hunter22"))
        XCTAssertFalse(maskSensitive("key ghp_abcdefghijklmnopqrstuvwxyz123456").contains("ghp_"))
        XCTAssertTrue(maskSensitive("card 4242 4242 4242 4242").contains("[REDACTED]"))
    }

    func testChangedWritingTargetNeverMatches() {
        let original = "hello 🐾 world"
        let range = NSRange(location: 6, length: 2)
        XCTAssertTrue(writingTargetMatches(originalValue: original, currentValue: original, originalRange: range, currentRange: range, originalSelection: "🐾", currentSelection: "🐾"))
        XCTAssertFalse(writingTargetMatches(originalValue: original, currentValue: "new content", originalRange: range, currentRange: range, originalSelection: "🐾", currentSelection: "🐾"))
        XCTAssertFalse(writingTargetMatches(originalValue: "", currentValue: "", originalRange: nil, currentRange: nil, originalSelection: "original", currentSelection: "changed"))
        XCTAssertFalse(writingTargetMatches(originalValue: original, currentValue: original, originalRange: range, currentRange: NSRange(location: 0, length: 5), originalSelection: "🐾", currentSelection: "hello"))
    }

    func testPasswordManagersAreExcluded() {
        XCTAssertTrue(isBlockedApplication("com.1password.1password"))
        XCTAssertTrue(isBlockedApplication("com.apple.Passwords"))
        XCTAssertTrue(isBlockedApplication("app.desktoppets.pace"))
        XCTAssertFalse(isBlockedApplication("com.apple.TextEdit"))
    }

    func testSecureFieldRoleIsExcludedBeforeReadingText() {
        XCTAssertTrue(isSecureTextField(kAXSecureTextFieldSubrole))
        XCTAssertFalse(isSecureTextField(kAXSearchFieldSubrole))
        XCTAssertFalse(isSecureTextField(nil))
    }

    func testDiarizationResponseValidation() throws {
        let segments = try parseDiarizationSegments(Data(#"{"segments":[{"start":0.1,"end":2.2,"speaker":1},{"start":2.2,"end":3,"speaker":2}]}"#.utf8))
        XCTAssertEqual(segments.count, 2)
        XCTAssertEqual(segments[0]["startMs"] as? Int, 100)
        XCTAssertEqual(segments[1]["speaker"] as? Int, 2)
        XCTAssertThrowsError(try parseDiarizationSegments(Data(#"{"segments":[{"start":3,"end":2,"speaker":1}]}"#.utf8)))
    }
}
