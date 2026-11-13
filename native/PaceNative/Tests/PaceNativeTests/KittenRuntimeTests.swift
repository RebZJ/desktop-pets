import XCTest
import MLX
import MLXRandom
import MLXAudioCore
import MLXAudioTTS
@testable import PaceNative

final class KittenRuntimeTests: XCTestCase {
    func testDeterministicOfflineFixture() async throws {
        guard let output = ProcessInfo.processInfo.environment["PACE_KITTEN_FIXTURE"] else {
            throw XCTSkip("Set PACE_KITTEN_FIXTURE to benchmark installed Kitten weights and save a deterministic waveform.")
        }
        let directory = URL(fileURLWithPath: output, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let definition = try ModelStore.require(KittenBundle.modelID)
        let loaded = Date()
        let model = try await KittenTTSModel.fromModelDirectory(definition.directory, textProcessor: KittenBundle.processor(in: definition.directory))
        let loadMs = Date().timeIntervalSince(loaded) * 1000
        do {
            _ = try await model.generate(text: String(repeating: "hello ", count: 600), voice: "Kiki", refAudio: nil, refText: nil, language: "English", generationParameters: model.defaultGenerationParameters)
            XCTFail("Overlong speech must fail before the embedding lookup.")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("too long for Kitten"), error.localizedDescription)
        }
        var results: [[String: Any]] = []
        for round in 0..<2 {
            MLXRandom.seed(42)
            Memory.peakMemory = 0
            let started = Date()
            let audio = try await model.generate(text: "Hi! I am Pace, your little desktop friend.", voice: "Kiki", refAudio: nil, refText: nil, language: "English", generationParameters: model.defaultGenerationParameters)
            let samples = audio.asArray(Float.self)
            let elapsed = Date().timeIntervalSince(started) * 1000
            XCTAssertGreaterThan(samples.count, 24_000)
            XCTAssertTrue(samples.allSatisfy(\.isFinite))
            XCTAssertGreaterThan(samples.map(abs).max()!, 0.01)
            try AudioUtils.writeWavFile(samples: samples, sampleRate: model.sampleRate, fileURL: directory.appendingPathComponent("greeting-\(round).wav"))
            results.append(["round": round, "loadMs": loadMs, "synthesisMs": elapsed, "frames": samples.count, "sampleRate": model.sampleRate, "mlxPeakBytes": Memory.peakMemory])
            Memory.clearCache()
        }
        try JSONSerialization.data(withJSONObject: results, options: [.prettyPrinted, .sortedKeys]).write(to: directory.appendingPathComponent("metrics.json"))
    }
}
