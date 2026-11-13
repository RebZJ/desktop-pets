import XCTest
import MLXAudioTTS
@testable import PaceNative

final class VoiceTests: XCTestCase {
    func testExplicitOfflineProcessorDoesNotTryToRepairMissingResources() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let processor = MisakiTextProcessor(directory: directory)
        try await processor.prepare()
        XCTAssertThrowsError(try processor.process(text: "Hello, Pace.", language: "English"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
    }

    func testVoiceTensorConversionPreservesSamplesAndRejectsWrongLayout() throws {
        let header = Data("{'descr': '<f4', 'fortran_order': False, 'shape': (400, 256), }\n".utf8)
        var numpy = Data([147, 78, 85, 77, 80, 89, 1, 0, UInt8(header.count), 0])
        numpy.append(header)
        let samples = Data(repeating: 42, count: 400 * 256 * 4)
        numpy.append(samples)
        XCTAssertEqual(try KittenBundle.voiceTensor(from: numpy), samples)
        XCTAssertThrowsError(try KittenBundle.voiceTensor(from: numpy.dropLast()))
        var invalid = numpy
        invalid[0] = 0
        XCTAssertThrowsError(try KittenBundle.voiceTensor(from: invalid))
        XCTAssertThrowsError(try KittenBundle.voiceTensor(from: Data([1, 2, 3])))
    }

    func testAutomaticEnginePreservesExistingQwenInstallAndVoiceChoice() throws {
        let old = try VoiceSettings.selection(engine: "auto", language: "English", voice: "Ono_Anna", kittenInstalled: false, qwenInstalled: true)
        XCTAssertEqual(old.model, "qwen3-tts-0.6b")
        XCTAssertEqual(old.voice, "Ono_Anna")
        let fast = try VoiceSettings.selection(engine: "auto", language: "English", voice: "Ono_Anna", kittenInstalled: true, qwenInstalled: true)
        XCTAssertEqual(fast.model, KittenBundle.modelID)
        XCTAssertEqual(fast.voice, "Kiki")
        let explicit = try VoiceSettings.selection(engine: "qwen", language: "English", voice: "Kiki", kittenInstalled: true, qwenInstalled: true)
        XCTAssertEqual(explicit.model, "qwen3-tts-0.6b")
        XCTAssertEqual(explicit.voice, "Serena")
        XCTAssertThrowsError(try VoiceSettings.selection(engine: "remote", language: "English", voice: "Kiki", kittenInstalled: true, qwenInstalled: true))
        XCTAssertThrowsError(try VoiceSettings.selection(engine: "auto", language: "English", voice: "missing", kittenInstalled: true, qwenInstalled: true))
    }

    func testKittenDoesNotClaimToSpeakOtherLanguages() throws {
        for (language, voice) in [("Chinese", "Vivian"), ("Japanese", "Ono_Anna"), ("Spanish", "Serena")] {
            let fallback = try VoiceSettings.selection(engine: "kitten", language: language, voice: "Kiki", kittenInstalled: true, qwenInstalled: true)
            XCTAssertEqual(fallback.model, "qwen3-tts-0.6b")
            XCTAssertEqual(fallback.voice, voice)
        }
        XCTAssertEqual(try VoiceSettings.resolvedLanguage("auto", text: "今天的会议已经结束了，我们明天再继续工作。"), "Chinese")
        XCTAssertEqual(try VoiceSettings.resolvedLanguage("auto", text: "こんにちは。今日も一緒に楽しくお仕事をしましょう。"), "Japanese")
        XCTAssertEqual(try VoiceSettings.resolvedLanguage("auto", text: "Hola, soy tu pequeño compañero de escritorio. Vamos a trabajar juntos hoy."), "Spanish")
    }

    func testKittenOfflinePronunciationBundleRejectsIncompleteOrCorruptFiles() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        XCTAssertThrowsError(try KittenBundle.processor(in: directory))
        let weights = directory.appendingPathComponent(KittenBundle.g2pFiles[0].path)
        try FileManager.default.createDirectory(at: weights.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(repeating: 0, count: Int(KittenBundle.g2pFiles[0].size)).write(to: weights)
        XCTAssertThrowsError(try KittenBundle.processor(in: directory))
        XCTAssertTrue(KittenBundle.g2pFiles.allSatisfy { $0.sourceURL?.contains(KittenBundle.g2pRevision) == true })
    }
}
