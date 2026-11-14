import XCTest
import AVFoundation
import ApplicationServices
import CoreMedia
import ScreenCaptureKit
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
        let live = try XCTUnwrap(sink.status()["level"] as? [String: Double])
        XCTAssertGreaterThan(try XCTUnwrap(live["rms"]), 0.1)
        XCTAssertGreaterThan(try XCTUnwrap(live["peak"]), 0.2)
        let result = try sink.finish()
        XCTAssertNil(result["error"])
        let frames = try XCTUnwrap(result["frames"] as? Int64)
        XCTAssertEqual(frames, 1600)
        let wav = try Data(contentsOf: folder.appendingPathComponent("converted.wav"))
        XCTAssertTrue(wav.dropFirst(44).contains(where: { $0 != 0 }))
        XCTAssertNotNil(sink.status()["offsetMs"])
    }

    func testSharedMeetingIdentityPreservesMillisecondsAndRejectsInvalidOrigins() throws {
        let id = UUID().uuidString.lowercased()
        let milliseconds = Date().timeIntervalSince1970 * 1000 - 250.125
        let (actualID, origin) = try meetingIdentity(["_sessionId": id, "_originUnixMs": milliseconds])
        XCTAssertEqual(actualID, id)
        XCTAssertEqual(origin.timeIntervalSince1970 * 1000, milliseconds, accuracy: 0.001)
        for params: [String: Any] in [["_sessionId":"../other", "_originUnixMs":milliseconds], ["_sessionId":id], ["_sessionId":id,"_originUnixMs":Double.nan], ["_sessionId":id,"_originUnixMs":0.0]] {
            XCTAssertThrowsError(try meetingIdentity(params))
        }
    }

    func testInputLevelsDistinguishDigitalSilenceAndExpireWhenInputStops() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let sink = try AudioSink(url: folder.appendingPathComponent("levels.wav"), sessionId: "fixture", track: "microphone", startDate: Date(), emit: { _ in })
        try sink.appendPCMForTesting(Data(repeating: 0, count: 3200))
        XCTAssertEqual(sink.status()["level"] as? [String: Double], ["rms": 0, "peak": 0])
        var pcm = Data()
        for value: Int16 in [16384, -16384, Int16.min, 0] {
            var value = value.littleEndian
            withUnsafeBytes(of: &value) { pcm.append(contentsOf: $0) }
        }
        try sink.appendPCMForTesting(pcm)
        let level = try XCTUnwrap(sink.status()["level"] as? [String: Double])
        XCTAssertEqual(try XCTUnwrap(level["peak"]), 1)
        XCTAssertEqual(try XCTUnwrap(level["rms"]), sqrt(0.375), accuracy: 0.000001)
        Thread.sleep(forTimeInterval: 0.3)
        XCTAssertEqual(sink.status()["level"] as? [String: Double], ["rms": 0, "peak": 0])
        _ = try sink.finish()
    }

    func testSystemAudioDelegateCopiesFloatStereoSampleBuffersToPCM16WAV() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        for (interleaved, source) in [(false, "both"), (true, "both"), (false, "left"), (true, "left"), (false, "right"), (true, "right")] {
            let suffix = (interleaved ? "interleaved" : "planar") + "-" + source
            let url = folder.appendingPathComponent("system-\(suffix).wav")
            var events: [[String: Any]] = []
            let sink = try AudioSink(url: url, sessionId: "sample-fixture", track: "system", startDate: Date(), emit: { events.append($0) })
            let controlURL = folder.appendingPathComponent("control-\(suffix).wav")
            let control = try AudioSink(url: controlURL, sessionId: "control", track: "system", startDate: Date(), emit: { _ in })
            let capture = SystemAudioCapture(sink: sink, sessionId: "sample-fixture", applicationBundleId: nil, emit: { events.append($0) })
            // An inert stream lets the real delegate run without starting capture or asking permission.
            let stream = SCStream(filter: SCContentFilter(), configuration: SCStreamConfiguration(), delegate: nil)
            let format = try XCTUnwrap(AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 2, interleaved: interleaved))
            for block in 0..<25 {
                let pcm = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 480))
                pcm.frameLength = 480
                for frame in 0..<480 {
                    let time = Double(block * 480 + frame) / 48_000
                    let left = Float(sin(time * 2 * .pi * 440) * (source == "right" ? 0 : 0.3))
                    let right = Float(sin(time * 2 * .pi * 880) * (source == "left" ? 0 : 0.2))
                    if interleaved {
                        pcm.floatChannelData![0][frame * 2] = left
                        pcm.floatChannelData![0][frame * 2 + 1] = right
                    } else {
                        pcm.floatChannelData![0][frame] = left
                        pcm.floatChannelData![1][frame] = right
                    }
                }
                let sample = try systemSampleBuffer(pcm, startFrame: block * 480)
                XCTAssertTrue(sample.isValid)
                XCTAssertTrue(CMSampleBufferDataIsReady(sample))
                capture.stream(stream, didOutputSampleBuffer: sample, of: .audio)
                control.append(pcm)
            }
            let live = try XCTUnwrap(sink.status()["level"] as? [String: Double])
            XCTAssertGreaterThan(try XCTUnwrap(live["rms"]), 0.02, "The input meter must see converted system audio: \(suffix)")
            let result = try sink.finish()
            let controlResult = try control.finish()
            XCTAssertNil(result["error"])
            XCTAssertNil(controlResult["error"])
            XCTAssertFalse(events.contains { $0["event"] as? String == "audio.error" })
            XCTAssertEqual(result["frames"] as? Int64, 4000)
            let wav = try Data(contentsOf: url)
            let referenceWAV = try Data(contentsOf: controlURL)
            XCTAssertEqual(wav.count, 8044)
            XCTAssertEqual(Array(wav[22..<24]), [1, 0])
            XCTAssertEqual(Array(wav[24..<28]), [128, 62, 0, 0])
            XCTAssertEqual(Array(wav[34..<36]), [16, 0])
            let samples = stride(from: 44, to: wav.count, by: 2).map { Int16(bitPattern: UInt16(wav[$0]) | UInt16(wav[$0 + 1]) << 8) }
            let reference = stride(from: 44, to: referenceWAV.count, by: 2).map { Int16(bitPattern: UInt16(referenceWAV[$0]) | UInt16(referenceWAV[$0 + 1]) << 8) }
            XCTAssertEqual(samples.count, reference.count)
            let extractionError = sqrt(zip(samples, reference).map { pow(Double($0.0) - Double($0.1), 2) }.reduce(0, +) / Double(samples.count))
            XCTAssertLessThan(extractionError, 2, "Sample-buffer extraction must match direct PCM conversion: \(suffix)")
            let normalized = samples.dropFirst(100).dropLast(100).map { Double($0) / 32768 }
            let rms = sqrt(normalized.map { $0 * $0 }.reduce(0, +) / Double(normalized.count))
            XCTAssertGreaterThan(rms, 0.05, "The real system-audio callback must not turn a tone into zeros: \(suffix)")
            var amplitudes: [Double: Double] = [:]
            for frequency in (source == "right" ? [880.0] : source == "left" ? [440.0] : [440.0, 880.0]) {
                var real = 0.0, imaginary = 0.0
                for (index, sample) in normalized.enumerated() {
                    let phase = Double(index) * 2 * .pi * frequency / 16_000
                    real += sample * cos(phase); imaginary += sample * sin(phase)
                }
                let amplitude = 2 * hypot(real, imaginary) / Double(normalized.count)
                amplitudes[frequency] = amplitude
                XCTAssertGreaterThan(amplitude, 0.015, "Each source channel must reach the mono WAV: \(suffix), \(frequency) Hz")
            }
            if source == "both" {
                XCTAssertEqual(try XCTUnwrap(amplitudes[440]) / XCTUnwrap(amplitudes[880]), 1.5, accuracy: 0.04, "Downmix must preserve relative stereo levels: \(suffix)")
            }
        }
    }

    private func systemSampleBuffer(_ pcm: AVAudioPCMBuffer, startFrame: Int) throws -> CMSampleBuffer {
        var description: CMAudioFormatDescription?
        XCTAssertEqual(CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: pcm.format.streamDescription,
            layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &description), noErr)
        let format = try XCTUnwrap(description)
        var sample: CMSampleBuffer?
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 48_000),
            presentationTimeStamp: CMTime(value: Int64(startFrame), timescale: 48_000), decodeTimeStamp: .invalid)
        XCTAssertEqual(CMSampleBufferCreate(allocator: kCFAllocatorDefault, dataBuffer: nil, dataReady: false,
            makeDataReadyCallback: nil, refcon: nil, formatDescription: format, sampleCount: Int(pcm.frameLength),
            sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &sample), noErr)
        let result = try XCTUnwrap(sample)
        XCTAssertEqual(CMSampleBufferSetDataBufferFromAudioBufferList(result, blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault, flags: 0, bufferList: pcm.audioBufferList), noErr)
        XCTAssertEqual(CMSampleBufferSetDataReady(result), noErr)
        return result
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
