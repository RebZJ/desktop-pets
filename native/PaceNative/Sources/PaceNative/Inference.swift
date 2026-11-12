import Foundation
import MLX
import MLXLLM
import MLXLMCommon
import MLXHuggingFace
import HuggingFace
import Tokenizers
import MLXAudioTTS
import MLXAudioCore

actor InferenceService {
    static let shared = InferenceService()
    private var textModel: ModelContainer?
    private var speechModel: SpeechGenerationModel?
    private var busy = false

    func status() -> [String: Any] {
        ["busy": busy, "textLoaded": textModel != nil, "voiceLoaded": speechModel != nil,
         "backend": "MLX Swift · Apple Silicon", "offline": true]
    }

    func releaseVoice() {
        speechModel = nil
        Memory.clearCache()
    }

    func chat(params: [String: Any], emit: @escaping Emit) async throws -> [String: Any] {
        guard !busy else { throw WorkerError("busy", "Pace is already generating. Try again when it finishes.") }
        guard let raw = params["messages"] as? [[String: Any]], !raw.isEmpty, raw.count <= 100 else { throw WorkerError("invalid_params", "Provide 1–100 chat messages.") }
        var messages = try raw.map { message -> Chat.Message in
            guard let roleName = message["role"] as? String, let role = Chat.Message.Role(rawValue: roleName), role != .tool,
                  let content = message["content"] as? String, !content.isEmpty, content.utf8.count <= 100_000 else { throw WorkerError("invalid_params", "Messages require a system, user or assistant role and text content.") }
            return Chat.Message(role: role, content: content)
        }
        let maxTokens = params["maxTokens"] as? Int ?? 512
        guard (1...2048).contains(maxTokens) else { throw WorkerError("invalid_params", "maxTokens must be between 1 and 2048.") }
        let definition = try ModelStore.require("qwen3.5-4b")
        busy = true
        defer { busy = false; Memory.clearCache() }
        if textModel == nil {
            emit(["event": "runtime.loading", "data": ["model": definition.id]])
            textModel = try await LLMModelFactory.shared.loadContainer(from: definition.directory, using: #huggingFaceTokenizerLoader())
        }
        guard let model = textModel else { throw WorkerError("model_load_failed", "The text model did not load.") }
        var trimmed = 0
        while true {
            let inputCount = try await model.perform(nonSendable: messages) { context, candidate in
                let input = try await context.processor.prepare(input: UserInput(chat: candidate, additionalContext: ["enable_thinking": false]))
                return input.text.tokens.size
            }
            if inputCount + maxTokens <= 8192 { break }
            guard let oldest = messages.dropLast().firstIndex(where: { $0.role != .system }) else {
                throw WorkerError("context_too_long", "Your system instructions and latest message exceed Pace’s 8K context. Shorten the latest message or instructions.")
            }
            messages.remove(at: oldest); trimmed += 1
        }
        if trimmed > 0 { emit(["event": "chat.contextTrimmed", "data": ["removedMessages": trimmed]]) }
        try Task.checkCancellation()
        let session = ChatSession(model, generateParameters: .init(maxTokens: maxTokens, maxKVSize: 8192, temperature: 0.7, topP: 0.9, topK: 20, repetitionPenalty: 1.1), additionalContext: ["enable_thinking": false])
        var result = ""
        for try await chunk in session.streamResponse(to: messages) {
            try Task.checkCancellation()
            result += chunk
            emit(["event": "chat.delta", "data": ["text": chunk]])
        }
        try Task.checkCancellation()
        guard !result.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw WorkerError("empty_generation", "The model returned no answer. Try again.") }
        return ["text": result, "model": definition.id]
    }

    func speak(params: [String: Any], emit: @escaping Emit) async throws -> [String: Any] {
        guard !busy else { throw WorkerError("busy", "Pace is already generating. Try again when it finishes.") }
        guard let text = params["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.count <= 1500 else { throw WorkerError("invalid_params", "Provide 1–1500 characters to speak.") }
        let language = try VoiceSettings.language(params["language"] as? String ?? "English")
        let voice = params["voice"] as? String ?? "Ono_Anna"
        guard VoiceSettings.voices.contains(voice) else { throw WorkerError("invalid_params", "Unknown voice preset.") }
        let pitch = params["pitch"] as? Double ?? 1.05
        let rate = params["rate"] as? Double ?? 1
        let volume = params["volume"] as? Double ?? 0.65
        guard (0.75...1.5).contains(pitch), (0.5...1.5).contains(rate), (0...1).contains(volume) else { throw WorkerError("invalid_params", "Voice pitch, rate or volume is outside the supported range.") }
        let definition = try ModelStore.require("qwen3-tts-0.6b")
        busy = true
        defer { busy = false; Memory.clearCache() }
        if speechModel == nil {
            emit(["event": "runtime.loading", "data": ["model": definition.id]])
            speechModel = try await TTS.loadModel(modelRepo: definition.directory.path)
        }
        guard let model = speechModel else { throw WorkerError("model_load_failed", "The voice model did not load.") }
        try Task.checkCancellation()
        var samples: [Float] = []
        let generation = MLXAudioCore.GenerateParameters(maxTokens: 1536, temperature: 0.7, topP: 0.9, repetitionPenalty: 1.1)
        emit(["event": "voice.generating", "data": ["voice": voice, "language": language]])
        for try await chunk in model.generateSamplesStream(text: text, voice: voice, refAudio: nil, refText: nil, language: language, generationParameters: generation, streamingInterval: 0.5) {
            try Task.checkCancellation()
            samples.append(contentsOf: chunk)
        }
        guard !samples.isEmpty, samples.allSatisfy(\.isFinite) else { throw WorkerError("empty_generation", "The voice model returned invalid audio.") }
        try Task.checkCancellation()
        try FileManager.default.createDirectory(at: NativePaths.generated, withIntermediateDirectories: true)
        let path = NativePaths.generated.appendingPathComponent("voice-\(UUID().uuidString).wav")
        try AudioUtils.writeWavFile(samples: samples, sampleRate: Double(model.sampleRate), fileURL: path)
        let result: [String: Any] = ["path": path.path, "sampleRate": model.sampleRate, "duration": Double(samples.count) / Double(model.sampleRate), "voice": voice, "language": language]
        if params["play"] as? Bool != false { try await VoicePlayback.shared.play(path, pitch: pitch, rate: rate, volume: volume, emit: emit) }
        emit(["event": "voice.ready", "data": result])
        return result
    }
}
