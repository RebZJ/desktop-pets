import Foundation
import AVFoundation
import NaturalLanguage
import MLXAudioTTS

enum VoiceSettings {
    static let qwenVoices = ["Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric", "Ryan", "Aiden", "Ono_Anna", "Sohee"]
    static let kittenVoices = ["Kiki", "Bella", "Rosie", "Luna", "Jasper", "Bruno", "Hugo", "Leo"]
    static let voices = kittenVoices + qwenVoices
    static func language(_ value: String) throws -> String {
        let map = ["en": "English", "zh": "Chinese", "zh-cn": "Chinese", "zh-hans": "Chinese", "zh-hant": "Chinese", "mandarin": "Chinese", "ja": "Japanese", "es": "Spanish", "ko": "Korean", "de": "German", "fr": "French", "ru": "Russian", "pt": "Portuguese", "it": "Italian", "auto": "Auto"]
        let name = map[value.lowercased()] ?? value
        guard ["English", "Chinese", "Japanese", "Spanish", "Korean", "German", "French", "Russian", "Portuguese", "Italian", "Auto"].contains(name) else { throw WorkerError("invalid_params", "Unsupported speech language.") }
        return name
    }

    static func resolvedLanguage(_ value: String, text: String) throws -> String {
        let requested = try language(value)
        guard requested == "Auto" else { return requested }
        let recognizer = NLLanguageRecognizer()
        recognizer.processString(text)
        guard let detected = recognizer.dominantLanguage else { throw WorkerError("invalid_params", "Choose a speech language for this text.") }
        return try language(detected.rawValue)
    }

    static func selection(engine: String, language: String, voice: String, kittenInstalled: Bool, qwenInstalled: Bool) throws -> (model: String, voice: String) {
        guard ["auto", "kitten", "qwen"].contains(engine), voices.contains(voice) else { throw WorkerError("invalid_params", "Unknown voice engine or preset.") }
        let kitten = language == "English" && engine != "qwen" && (engine == "kitten" || kittenInstalled || !qwenInstalled)
        if kitten { return (KittenBundle.modelID, kittenVoices.contains(voice) ? voice : "Kiki") }
        let fallback = language == "Japanese" ? "Ono_Anna" : (language == "Chinese" ? "Vivian" : (language == "Korean" ? "Sohee" : "Serena"))
        return ("qwen3-tts-0.6b", qwenVoices.contains(voice) ? voice : fallback)
    }
}

@MainActor
final class VoicePlayback {
    static let shared = VoicePlayback()
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var effect: AVAudioUnitTimePitch?
    private var emit: Emit?
    private var playbackId: UUID?
    private var pending = 0
    private var finished = false

    func begin(sampleRate: Double, pitch: Double, rate: Double, volume: Double, emit: @escaping Emit) throws -> UUID {
        stop()
        let id = UUID()
        if engine == nil || player?.outputFormat(forBus: 0).sampleRate != sampleRate {
            let engine = AVAudioEngine(); let player = AVAudioPlayerNode(); let effect = AVAudioUnitTimePitch()
            guard let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1) else { throw WorkerError("audio_format", "The voice sample rate is unsupported.") }
            engine.attach(player); engine.attach(effect)
            engine.connect(player, to: effect, format: format)
            engine.connect(effect, to: engine.mainMixerNode, format: format)
            self.engine = engine; self.player = player; self.effect = effect
        }
        effect?.pitch = Float(1200 * log2(pitch)); effect?.rate = Float(rate)
        engine?.mainMixerNode.outputVolume = Float(volume)
        self.emit = emit; self.playbackId = id
        return id
    }

    func append(_ samples: [Float], session: UUID) throws {
        guard playbackId == session, let engine, let player else { throw CancellationError() }
        guard !samples.isEmpty, samples.allSatisfy(\.isFinite), samples.count <= Int(UInt32.max),
              let buffer = AVAudioPCMBuffer(pcmFormat: player.outputFormat(forBus: 0), frameCapacity: AVAudioFrameCount(samples.count)),
              let channel = buffer.floatChannelData?[0] else { throw WorkerError("invalid_audio", "The voice model returned invalid audio.") }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { channel.update(from: $0.baseAddress!, count: samples.count) }
        pending += 1
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.playbackId == session else { return }
                self.pending -= 1
                if self.finished && self.pending == 0 { self.stop(session: session) }
            }
        }
        if !engine.isRunning {
            do { try engine.start() }
            catch {
                stop(); self.engine = nil; self.player = nil; self.effect = nil
                throw error
            }
            player.play()
            emit?(["event": "voice.started", "data": ["streaming": true, "outputLatencySeconds": engine.outputNode.presentationLatency]])
        }
    }

    func finish(session: UUID) {
        guard playbackId == session else { return }
        finished = true
        if pending == 0 { stop(session: session) }
    }

    func stop(session: UUID? = nil) {
        if let session, session != playbackId { return }
        player?.stop(); engine?.stop(); engine?.reset()
        playbackId = nil; pending = 0; finished = false
        emit?(["event": "voice.stopped", "data": [:]])
        emit = nil
    }
}

extension KittenBundle {
    static func processor(in directory: URL) throws -> MisakiTextProcessor {
        for file in g2pFiles {
            guard try ModelStore.verify(directory.appendingPathComponent(file.path), file: file) else {
                throw WorkerError("model_not_installed", "Kitten's offline pronunciation bundle is incomplete. Reinstall KittenTTS in Settings.")
            }
        }
        return MisakiTextProcessor(directory: directory.appendingPathComponent(g2pDirectory))
    }
}
