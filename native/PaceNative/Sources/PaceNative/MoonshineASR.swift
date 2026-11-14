import Foundation
import AVFoundation
import CMoonshine

final class MoonshineASR {
    private let handle: Int32

    init(model: ModelDefinition, language: String) throws {
        let values = [("return_audio_data", "false"), ("max_tokens_per_second", ["zh", "ja"].contains(language) ? "13.0" : "6.5"),
                      ("vad_threshold", "0.2"), ("vad_window_duration", "0.1"), ("vad_look_behind_sample_count", "32000")]
        let storage = values.map { (strdup($0.0), strdup($0.1)) }
        defer { for (name, value) in storage { free(name); free(value) } }
        let options = storage.map { moonshine_option_t(name: UnsafePointer($0.0), value: UnsafePointer($0.1)) }
        let loaded = model.directory.path.withCString { path in
            options.withUnsafeBufferPointer {
                moonshine_load_transcriber_from_files(path, UInt32(MOONSHINE_MODEL_ARCH_TINY_STREAMING), $0.baseAddress, UInt64($0.count), Int32(MOONSHINE_HEADER_VERSION))
            }
        }
        guard loaded >= 0 else { throw Self.error(loaded) }
        handle = loaded
    }

    deinit { moonshine_free_transcriber(handle) }

    func transcribe(_ input: URL, language: String, vocabulary: [String]) throws -> [String: Any] {
        let started = Date()
        let terms = vocabulary.joined(separator: ",")
        let configured = terms.withCString { moonshine_transcriber_set_keyterms(handle, $0) }
        guard configured == 0 else { throw Self.error(configured) }
        let audio = try AVAudioFile(forReading: input, commonFormat: .pcmFormatFloat32, interleaved: false)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: audio.processingFormat, frameCapacity: 16_384) else { throw WorkerError("invalid_audio", "Could not read dictation audio.") }
        var samples: [Float] = []
        while audio.framePosition < audio.length {
            try Task.checkCancellation()
            try audio.read(into: buffer, frameCount: 16_384)
            guard buffer.frameLength > 0, let channel = buffer.floatChannelData?[0] else { throw WorkerError("invalid_audio", "Could not read the complete dictation recording.") }
            samples.append(contentsOf: UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength)))
        }
        guard !samples.isEmpty, samples.allSatisfy({ $0.isFinite && abs($0) <= 1 }) else { throw WorkerError("invalid_audio", "Dictation requires finite PCM samples between minus one and one.") }
        // A fresh stream isolates VAD and transcript state between dictations.
        let stream = moonshine_create_stream(handle, 0)
        guard stream >= 0 else { throw Self.error(stream) }
        defer { _ = moonshine_free_stream(handle, stream) }
        let startStatus = moonshine_start_stream(handle, stream)
        guard startStatus == 0 else { throw Self.error(startStatus) }
        let fed = samples.withUnsafeBufferPointer {
            moonshine_transcribe_add_audio_to_stream(handle, stream, $0.baseAddress, UInt64($0.count), 16_000, 0)
        }
        guard fed == 0 else { throw Self.error(fed) }
        let stopped = moonshine_stop_stream(handle, stream)
        guard stopped == 0 else { throw Self.error(stopped) }
        var transcript: UnsafeMutablePointer<transcript_t>?
        let status = moonshine_transcribe_stream(handle, stream, 0, &transcript)
        guard status == 0 else { throw Self.error(status) }
        try Task.checkCancellation()
        guard let transcript, transcript.pointee.line_count <= UInt64(samples.count / 1600 + 1) else { throw WorkerError("transcription_failed", "The speech model returned an invalid transcript.") }
        var segments: [[String: Any]] = []
        let count = Int(transcript.pointee.line_count)
        if count > 0 {
            guard let lines = transcript.pointee.lines else { throw WorkerError("transcription_failed", "The speech model returned missing transcript lines.") }
            for index in 0..<count {
                let line = lines[index]
                guard let pointer = line.text else { throw WorkerError("transcription_failed", "The speech model returned an invalid transcript line.") }
                let text = String(cString: pointer).trimmingCharacters(in: .whitespacesAndNewlines)
                if text.isEmpty { continue }
                let start = Double(line.start_time), end = start + Double(line.duration)
                guard start.isFinite, end.isFinite, start >= 0, end > start, end <= Double(samples.count) / 16_000 + 1 else { throw WorkerError("transcription_failed", "The speech model returned invalid phrase times.") }
                segments.append(["text": text, "start": start, "end": end, "startMs": Int((start * 1000).rounded()), "endMs": Int((end * 1000).rounded())])
            }
        }
        let text = segments.compactMap { $0["text"] as? String }.joined(separator: ["zh", "ja"].contains(language) ? "" : " ")
        return ["text": text, "segments": segments, "language": language, "model": "moonshine-tiny-\(language)",
                "granularity": "phrase", "vad": "moonshine-embedded", "vocabularyTerms": vocabulary.count,
                "transcriptionMs": Date().timeIntervalSince(started) * 1000, "duration": Double(samples.count) / 16_000]
    }

    private static func error(_ code: Int32) -> WorkerError {
        let message = moonshine_error_to_string(code).map { String(cString: $0) } ?? "Unknown local speech error."
        return WorkerError("transcription_failed", "Moonshine: \(message)")
    }
}
