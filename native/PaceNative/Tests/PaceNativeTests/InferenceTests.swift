import XCTest
import CryptoKit
import AVFoundation
@testable import PaceNative

final class InferenceTests: XCTestCase {
    func testModelPathsRejectTraversal() {
        XCTAssertTrue(ModelStore.safeRelativePath("speech_tokenizer/model.safetensors"))
        for path in ["", "../model", "/tmp/model", "a/../b", "a//b", "./config.json"] {
            XCTAssertFalse(ModelStore.safeRelativePath(path), path)
        }
    }
    func testChecksumRejectsCorruptionAndWrongSize() throws {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: path) }
        let data = Data("verified model fixture".utf8)
        try data.write(to: path)
        let sha = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let file = ModelFile(path: "model", size: Int64(data.count), sha256: sha, gitBlob: nil)
        XCTAssertTrue(try ModelStore.verify(path, file: file))
        try Data(repeating: 0, count: data.count).write(to: path)
        XCTAssertFalse(try ModelStore.verify(path, file: file))
        try Data([1]).write(to: path)
        XCTAssertFalse(try ModelStore.verify(path, file: file))
    }
    func testPreciseModeRequiresActualBooleanRatherThanNumericOne() throws {
        XCTAssertFalse(try InferenceService.preciseMode([:]))
        XCTAssertFalse(try InferenceService.preciseMode(["precise": false]))
        XCTAssertTrue(try InferenceService.preciseMode(["precise": true]))
        let invalid: [Any] = [1, 0, 0.5, "true", NSNull(), [true]]
        for value in invalid {
            XCTAssertThrowsError(try InferenceService.preciseMode(["precise": value]))
        }
        let numeric = try JSONSerialization.jsonObject(with: Data("{\"precise\":1}".utf8)) as! [String: Any]
        XCTAssertThrowsError(try InferenceService.preciseMode(numeric))
    }
    func testVoiceLanguageNormalization() throws {
        XCTAssertEqual(try VoiceSettings.language("zh"), "Chinese")
        XCTAssertEqual(try VoiceSettings.language("ja"), "Japanese")
        XCTAssertEqual(try VoiceSettings.language("Spanish"), "Spanish")
        XCTAssertThrowsError(try VoiceSettings.language("unsupported"))
    }
    func testWhisperWordTimestampsPreserveSpeakerBoundary() throws {
        let fixture: [String: Any] = ["transcription": [
            ["text": " Hello", "offsets": ["from": 320, "to": 840]],
            ["text": " goodbye", "offsets": ["from": 1400, "to": 2100]],
        ]]
        let segments = try TranscriptionService.segments(from: fixture)
        XCTAssertEqual(segments.count, 2)
        XCTAssertEqual(segments[0]["endMs"] as? Int, 840)
        XCTAssertEqual(segments[1]["startMs"] as? Int, 1400)
        XCTAssertEqual(segments[1]["start"] as? Double, 1.4)
        XCTAssertEqual(segments[1]["end"] as? Double, 2.1)
        XCTAssertThrowsError(try TranscriptionService.segments(from: ["transcription": [["text": "bad", "offsets": ["from": 500, "to": 100]]]]))
    }
    func testZeroDurationWhisperTokensPreserveTextWithoutInventingTimes() throws {
        let segments = try TranscriptionService.segments(from: ["transcription": [
            ["text": " Hello", "offsets": ["from": 0, "to": 0]],
            ["text": " friend", "offsets": ["from": 100, "to": 500]],
            ["text": "!", "offsets": ["from": 500, "to": 500]],
        ]])
        XCTAssertEqual(segments.count, 1)
        XCTAssertEqual(segments[0]["text"] as? String, " Hello friend!")
        XCTAssertEqual(segments[0]["start"] as? Double, 0.1)
        XCTAssertEqual(segments[0]["end"] as? Double, 0.5)
    }
    func testWhisperInstallAddsPinnedVADWithoutReplacingExistingWeights() throws {
        let model = try ModelDefinition.find("whisper-turbo")
        let weights = ModelFile(path: model.singleFile!, size: 574_041_195, sha256: "existing-weights", gitBlob: nil)
        let old = ModelManifest(repository: model.repo, revision: "existing-pinned-revision", files: [weights])
        XCTAssertFalse(ModelStore.manifestIncludesSupplements(old, model: model))
        let upgraded = ModelStore.addingSupplements(to: old, model: model)
        XCTAssertEqual(upgraded.revision, "existing-pinned-revision")
        XCTAssertEqual(upgraded.files.first?.sha256, "existing-weights")
        XCTAssertTrue(ModelStore.manifestIncludesSupplements(upgraded, model: model))
        XCTAssertEqual(upgraded.files.count, 2)
        XCTAssertEqual(upgraded.files.last?.sha256, SileroVAD.file.sha256)
        XCTAssertTrue(upgraded.files.last?.sourceURL?.contains("/9ffd54a1e1ee413ddf265af9913beaf518d1639b/") == true)
        let legacy = try JSONDecoder().decode(ModelFile.self, from: Data("{\"path\":\"model.bin\",\"size\":1,\"sha256\":\"abc\"}".utf8))
        XCTAssertNil(legacy.sourceURL)
    }
    func testVADRejectsMissingOrMalformedDetectionInsteadOfAssumingSilence() throws {
        XCTAssertFalse(try TranscriptionService.hasSpeech("Detected 0 speech segments:\n"))
        XCTAssertTrue(try TranscriptionService.hasSpeech("\nDetected 2 speech segments:\nSpeech segment 0: start = 0.00, end = 100.00\n"))
        XCTAssertThrowsError(try TranscriptionService.hasSpeech("model could not load"))
        XCTAssertThrowsError(try TranscriptionService.hasSpeech("Detected -1 speech segments:"))
    }
    func testLongTranscriptionWindowsKeepOriginalOffsetsAndOwnBoundaryWordsOnce() throws {
        let windows = TranscriptionService.windows(frames: 65 * 16_000)
        XCTAssertEqual(windows.count, 3)
        XCTAssertEqual(windows[0].startFrame, 0)
        XCTAssertEqual(windows[0].endFrame, 29 * 16_000)
        XCTAssertEqual(windows[1].startFrame, 27 * 16_000)
        XCTAssertEqual(windows[1].endFrame, 57 * 16_000)
        XCTAssertEqual(windows[2].endFrame, 65 * 16_000)
        // These are the same two real words seen in the one-second overlap.
        let first = try TranscriptionService.segments(from: ["transcription": [
            ["text": " before", "offsets": ["from": 27_500, "to": 27_900]],
            ["text": " after", "offsets": ["from": 28_100, "to": 28_600]],
        ]])
        let second = try TranscriptionService.segments(from: ["transcription": [
            ["text": " before", "offsets": ["from": 500, "to": 900]],
            ["text": " after", "offsets": ["from": 1_100, "to": 1_600]],
        ]])
        let owned = TranscriptionService.ownedSegments(first, window: windows[0], isLast: false) + TranscriptionService.ownedSegments(second, window: windows[1], isLast: false)
        XCTAssertEqual(owned.count, 2)
        XCTAssertEqual(owned[0]["text"] as? String, " before")
        XCTAssertEqual(owned[1]["text"] as? String, " after")
        XCTAssertEqual(owned[1]["start"] as? Double, 28.1)
        XCTAssertEqual(owned[1]["end"] as? Double, 28.6)
        XCTAssertEqual(TranscriptionService.windows(frames: 30 * 16_000).count, 1)
    }

    func testLongWAVWindowReadsEveryFrameDespitePartialAVAudioFileReads() throws {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("window-\(UUID().uuidString).wav")
        defer { try? FileManager.default.removeItem(at: path) }
        var samples = Data()
        for index in 0..<500_000 {
            var value = Int16(index % 30_000).littleEndian
            withUnsafeBytes(of: &value) { samples.append(contentsOf: $0) }
        }
        try waveData(samples).write(to: path)
        let audio = try AVAudioFile(forReading: path, commonFormat: .pcmFormatInt16, interleaved: true)
        let window = TranscriptionService.Window(startFrame: 16_000, endFrame: 480_000, coreStartFrame: 16_000, coreEndFrame: 480_000)
        let actual = try TranscriptionService.readWindow(audio, window: window)
        XCTAssertEqual(actual, samples.subdata(in: 32_000..<960_000))
        XCTAssertEqual(audio.framePosition, 480_000)
    }

    func testDTWAlignmentKeepsLeadingSilenceAndUnicodeTokenBoundaries() throws {
        let fixture: [String: Any] = ["transcription": [["text": " Hello, I am ペース", "offsets": ["from": 0, "to": 22_000], "tokens": [
            ["text": "[_BEG_]", "id": 50_365, "t_dtw": -1],
            ["text": " Hello", "id": 100, "t_dtw": 1866],
            ["text": ",", "id": 11, "t_dtw": 1908],
            ["text": " I", "id": 286, "t_dtw": 1948],
            ["text": " am", "id": 20, "t_dtw": 1948],
            ["text": " ペ", "id": 30, "t_dtw": 2012],
            ["text": "ー", "id": 31, "t_dtw": 2032],
            ["text": "ス", "id": 32, "t_dtw": 2044],
        ]]]]
        let words = try TranscriptionService.alignedSegments(from: fixture)
        XCTAssertEqual(words[0]["start"] as? Double, 18.66)
        XCTAssertEqual(words[0]["text"] as? String, " Hello,")
        XCTAssertEqual(words[1]["text"] as? String, " I am")
        XCTAssertEqual(words.count, 5)
        XCTAssertEqual(words.map { $0["text"] as! String }.joined(), " Hello, I am ペース")
        XCTAssertTrue(words.allSatisfy { ($0["end"] as! Double) > ($0["start"] as! Double) })
        XCTAssertThrowsError(try TranscriptionService.alignedSegments(from: ["transcription": [["text": "bad", "tokens": [["text": "bad", "id": 100, "t_dtw": -1]]]]]))
    }

    func testDTWWordDoesNotExtendThroughPauseToNextTranscriptionItem() throws {
        let words = try TranscriptionService.alignedSegments(from: ["transcription": [
            ["text": " Hello", "offsets": ["from": 0, "to": 2_000], "tokens": [["text": " Hello", "id": 100, "t_dtw": 100]]],
            ["text": " friend", "offsets": ["from": 20_000, "to": 21_000], "tokens": [["text": " friend", "id": 200, "t_dtw": 2_000]]],
        ]])
        XCTAssertEqual(words[0]["start"] as? Double, 1)
        XCTAssertEqual(words[0]["end"] as? Double, 2)
        XCTAssertEqual(words[1]["start"] as? Double, 20)
        let boundary = TranscriptionService.Window(startFrame: 0, endFrame: 29 * 16_000, coreStartFrame: 0, coreEndFrame: 28 * 16_000)
        XCTAssertEqual(TranscriptionService.ownedSegments(words, window: boundary, isLast: false).count, 2)
    }

    func testVADRegionsUseCentisecondsAndMergeContextWithoutCompressingTime() throws {
        let regions = try TranscriptionService.speechRegions("Detected 3 speech segments:\nSpeech segment 0: start = 269.00, end = 829.00\nSpeech segment 1: start = 840.00, end = 900.00\nSpeech segment 2: start = 1261.00, end = 1814.00\n", frames: 20 * 16_000)
        XCTAssertEqual(regions.count, 2)
        XCTAssertEqual(regions[0].startFrame, 39_840) // 2.69 seconds minus 0.2 seconds.
        XCTAssertEqual(regions[0].endFrame, 147_200)
        XCTAssertEqual(regions[1].startFrame, 198_560)
        XCTAssertEqual(regions[1].endFrame, 293_440)
        XCTAssertTrue(try TranscriptionService.speechRegions("Detected 0 speech segments:\n", frames: 16_000).isEmpty)
        XCTAssertThrowsError(try TranscriptionService.speechRegions("Detected 1 speech segments:\n", frames: 16_000))
    }

}
