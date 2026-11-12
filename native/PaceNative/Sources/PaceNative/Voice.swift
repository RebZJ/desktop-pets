import Foundation
import AVFoundation

enum VoiceSettings {
    static let voices = ["Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric", "Ryan", "Aiden", "Ono_Anna", "Sohee"]
    static func language(_ value: String) throws -> String {
        let map = ["en": "English", "zh": "Chinese", "zh-cn": "Chinese", "mandarin": "Chinese", "ja": "Japanese", "es": "Spanish", "ko": "Korean", "de": "German", "fr": "French", "ru": "Russian", "pt": "Portuguese", "it": "Italian", "auto": "Auto"]
        let name = map[value.lowercased()] ?? value
        guard ["English", "Chinese", "Japanese", "Spanish", "Korean", "German", "French", "Russian", "Portuguese", "Italian", "Auto"].contains(name) else { throw WorkerError("invalid_params", "Unsupported speech language.") }
        return name
    }
}

@MainActor
final class VoicePlayback {
    static let shared = VoicePlayback()
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var emit: Emit?
    private var playbackId: UUID?
    func play(_ url: URL, pitch: Double, rate: Double, volume: Double, emit: @escaping Emit) throws {
        stop()
        let playbackId = UUID()
        self.playbackId = playbackId
        let file = try AVAudioFile(forReading: url)
        let engine = AVAudioEngine(); let player = AVAudioPlayerNode(); let effect = AVAudioUnitTimePitch()
        effect.pitch = Float(1200 * log2(pitch)); effect.rate = Float(rate)
        engine.attach(player); engine.attach(effect)
        engine.connect(player, to: effect, format: file.processingFormat)
        engine.connect(effect, to: engine.mainMixerNode, format: file.processingFormat)
        engine.mainMixerNode.outputVolume = Float(volume)
        player.scheduleFile(file, at: nil, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in if self?.playbackId == playbackId { self?.stop() } }
        }
        try engine.start(); player.play()
        self.engine = engine; self.player = player; self.emit = emit
        emit(["event": "voice.started", "data": ["path": url.path]])
    }
    func stop() {
        player?.stop(); engine?.stop(); player = nil; engine = nil
        playbackId = nil
        emit?(["event": "voice.stopped", "data": [:]])
        emit = nil
    }
}
