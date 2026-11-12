import Foundation
import AVFoundation

actor TranscriptionService {
    static let shared = TranscriptionService()
    private var busy = false
    func transcribe(params: [String: Any]) async throws -> [String: Any] {
        guard !busy else { throw WorkerError("busy", "A transcription is already running.") }
        guard let path = params["path"] as? String, path.hasPrefix("/"), FileManager.default.fileExists(atPath: path) else { throw WorkerError("invalid_params", "Provide an existing absolute WAV path.") }
        let input = URL(fileURLWithPath: path)
        guard input.pathExtension.lowercased() == "wav" else { throw WorkerError("invalid_params", "Transcription accepts WAV files.") }
        let audio = try AVAudioFile(forReading: input)
        guard audio.fileFormat.sampleRate == 16000, audio.fileFormat.channelCount == 1, audio.length > 0 else { throw WorkerError("invalid_audio", "Audio must be nonempty mono 16 kHz WAV.") }
        let model = try ModelStore.require("whisper-turbo")
        let vadModel = model.directory.appendingPathComponent(SileroVAD.filename)
        let executable = try Self.executable()
        let detector = try Self.executable(named: "whisper-vad-speech-segments", override: "PACE_VAD_BIN")
        let language = params["language"] as? String ?? "auto"
        guard language == "auto" || language.range(of: "^[a-z]{2,3}$", options: .regularExpression) != nil else { throw WorkerError("invalid_params", "Use an ISO language code such as en, zh, ja or es.") }
        busy = true; defer { busy = false }
        try FileManager.default.createDirectory(at: NativePaths.generated, withIntermediateDirectories: true)
        let work = NativePaths.generated.appendingPathComponent("transcript-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: work) }
        let windows = Self.windows(frames: audio.length)
        // VAD selects separately decoded regions with original context. The CLI
        // --vad concatenation path clips words and remaps removed silent gaps.
        let pcm = try AVAudioFile(forReading: input, commonFormat: .pcmFormatInt16, interleaved: true)
        var segments: [[String: Any]] = []
        var detected = language
        var speechWindows = 0
        for (index, window) in windows.enumerated() {
            try Task.checkCancellation()
            let windowAudio: URL
            if windows.count > 1 {
                windowAudio = work.appendingPathComponent("window.wav")
                try waveData(Self.readWindow(pcm, window: window)).write(to: windowAudio)
            } else { windowAudio = input }
            let vadOutput = try await Self.run(detector, arguments: ["-vm", vadModel.path, "-f", windowAudio.path, "-np", "-vt", "0.2", "-vp", "800", "-vsd", "500"], directory: work, name: "vad")
            let regions = try Self.speechRegions(vadOutput, frames: window.endFrame - window.startFrame)
            guard !regions.isEmpty else { continue }
            speechWindows += 1
            for region in regions {
                try Task.checkCancellation()
                // Decode padded regions independently, never concatenating them.
                // This prevents the decoder collapsing repeated phrases across a
                // pause or assigning a word's duration through that silent gap.
                let regionWindow = Window(startFrame: window.startFrame + region.startFrame, endFrame: window.startFrame + region.endFrame, coreStartFrame: window.coreStartFrame, coreEndFrame: window.coreEndFrame)
                let speechAudio: URL
                if region.startFrame == 0 && region.endFrame == window.endFrame - window.startFrame { speechAudio = windowAudio }
                else {
                    speechAudio = work.appendingPathComponent("speech.wav")
                    try waveData(Self.readWindow(pcm, window: regionWindow)).write(to: speechAudio)
                }
                let base = work.appendingPathComponent("words")
                _ = try await Self.run(executable, arguments: ["-m", model.directory.appendingPathComponent(model.singleFile!).path, "-f", speechAudio.path, "-l", language, "-ojf", "-of", base.path, "-np", "-t", "4", "-dtw", "large.v3.turbo", "-nfa"], directory: work, name: "whisper")
                let object = try JSONSerialization.jsonObject(with: Data(contentsOf: base.appendingPathExtension("json"))) as? [String: Any] ?? [:]
                if let value = (object["result"] as? [String: Any])?["language"] as? String { detected = value }
                let words = try Self.alignedSegments(from: object)
                segments += Self.ownedSegments(words, window: regionWindow, isLast: index == windows.count - 1)
            }
        }
        let text = segments.compactMap { $0["text"] as? String }.joined().trimmingCharacters(in: .whitespacesAndNewlines)
        return ["text": text, "segments": segments, "language": detected, "model": model.id, "vad": "silero-v6.2.0", "windows": windows.count, "speechWindows": speechWindows]
    }

    struct Window {
        let startFrame: Int64
        let endFrame: Int64
        let coreStartFrame: Int64
        let coreEndFrame: Int64
    }
    static func windows(frames: Int64) -> [Window] {
        let rate: Int64 = 16_000
        guard frames > 30 * rate else { return [Window(startFrame: 0, endFrame: frames, coreStartFrame: 0, coreEndFrame: frames)] }
        // Each 28-second core owns its words by midpoint. One second of original
        // context at each edge avoids cutting boundary words, without duplicates.
        return stride(from: Int64(0), to: frames, by: 28 * 16_000).map { start in
            let end = min(start + 28 * rate, frames)
            return Window(startFrame: max(0, start - rate), endFrame: min(frames, end + rate), coreStartFrame: start, coreEndFrame: end)
        }
    }
    static func readWindow(_ audio: AVAudioFile, window: Window) throws -> Data {
        let wanted = AVAudioFrameCount(window.endFrame - window.startFrame)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: audio.processingFormat, frameCapacity: 16_384) else { throw WorkerError("invalid_audio", "Could not allocate a transcription window.") }
        audio.framePosition = window.startFrame
        var data = Data(); data.reserveCapacity(Int(wanted) * 2)
        var read: AVAudioFrameCount = 0
        // AVAudioFile can return fewer frames than requested even before EOF.
        while read < wanted {
            try audio.read(into: buffer, frameCount: min(buffer.frameCapacity, wanted - read))
            guard buffer.frameLength > 0, let samples = buffer.int16ChannelData?[0] else { throw WorkerError("invalid_audio", "Could not read the complete transcription window.") }
            data.append(Data(bytes: samples, count: Int(buffer.frameLength) * 2))
            read += buffer.frameLength
        }
        return data
    }
    static func ownedSegments(_ words: [[String: Any]], window: Window, isLast: Bool) -> [[String: Any]] {
        let shiftMs = Int(window.startFrame * 1000 / 16_000)
        let coreStart = Int(window.coreStartFrame * 1000 / 16_000)
        let coreEnd = Int(window.coreEndFrame * 1000 / 16_000)
        return words.compactMap { word in
            guard let localStart = word["startMs"] as? Int, let localEnd = word["endMs"] as? Int else { return nil }
            let start = localStart + shiftMs, end = localEnd + shiftMs
            let midpoint = start + (end - start) / 2
            guard midpoint >= coreStart, midpoint < coreEnd || (isLast && midpoint == coreEnd) else { return nil }
            var result = word
            result["startMs"] = start; result["endMs"] = end
            result["start"] = Double(start) / 1000; result["end"] = Double(end) / 1000
            return result
        }
    }
    static func hasSpeech(_ output: String) throws -> Bool {
        let pattern = try NSRegularExpression(pattern: "(?m)^Detected ([0-9]+) speech segments:$")
        let range = NSRange(output.startIndex..<output.endIndex, in: output)
        guard let match = pattern.firstMatch(in: output, range: range), let countRange = Range(match.range(at: 1), in: output), let count = Int(output[countRange]) else { throw WorkerError("vad_failed", "Silero did not return a valid speech detection result.") }
        return count > 0
    }
    struct SpeechRegion { let startFrame: Int64; let endFrame: Int64 }
    static func speechRegions(_ output: String, frames: Int64) throws -> [SpeechRegion] {
        guard try hasSpeech(output) else { return [] }
        let pattern = try NSRegularExpression(pattern: "(?m)^Speech segment ([0-9]+): start = ([0-9]+(?:\\.[0-9]+)?), end = ([0-9]+(?:\\.[0-9]+)?)$")
        let matches = pattern.matches(in: output, range: NSRange(output.startIndex..<output.endIndex, in: output))
        var regions: [SpeechRegion] = []
        for match in matches {
            guard let startRange = Range(match.range(at: 2), in: output), let endRange = Range(match.range(at: 3), in: output), let start = Double(output[startRange]), let end = Double(output[endRange]), start.isFinite, end.isFinite, end > start, end < Double(Int64.max / 160) else { throw WorkerError("vad_failed", "Silero returned invalid speech regions.") }
            // This pinned whisper.cpp detector prints centiseconds, not seconds.
            // Its 800 ms padding plus 200 ms here retains one second of context.
            let first = max(0, Int64((start * 160).rounded()) - 3_200)
            let last = min(frames, Int64((end * 160).rounded()) + 3_200)
            guard first < last else { throw WorkerError("vad_failed", "Silero returned an out-of-range speech region.") }
            if let previous = regions.last, first <= previous.endFrame {
                regions[regions.count - 1] = SpeechRegion(startFrame: previous.startFrame, endFrame: max(previous.endFrame, last))
            } else { regions.append(SpeechRegion(startFrame: first, endFrame: last)) }
        }
        guard !regions.isEmpty else { throw WorkerError("vad_failed", "Silero did not return its detected speech regions.") }
        return regions
    }
    private static func run(_ executable: URL, arguments: [String], directory: URL, name: String) async throws -> String {
        let output = directory.appendingPathComponent("\(name).stdout")
        let diagnostic = directory.appendingPathComponent("\(name).stderr")
        FileManager.default.createFile(atPath: output.path, contents: nil)
        FileManager.default.createFile(atPath: diagnostic.path, contents: nil)
        let stdout = try FileHandle(forWritingTo: output), stderr = try FileHandle(forWritingTo: diagnostic)
        defer { try? stdout.close(); try? stderr.close() }
        let process = Process(); process.executableURL = executable; process.arguments = arguments
        process.standardOutput = stdout; process.standardError = stderr
        try process.run()
        do { while process.isRunning { try Task.checkCancellation(); try await Task.sleep(nanoseconds: 100_000_000) } }
        catch { if process.isRunning { process.terminate(); process.waitUntilExit() }; throw error }
        guard process.terminationStatus == 0 else {
            let message = (try? String(contentsOf: diagnostic, encoding: .utf8)) ?? "Local speech processing failed."
            throw WorkerError(name == "vad" ? "vad_failed" : "transcription_failed", String(message.suffix(1500)))
        }
        return (try? String(contentsOf: output, encoding: .utf8)) ?? ""
    }
    static func alignedSegments(from object: [String: Any]) throws -> [[String: Any]] {
        guard let items = object["transcription"] as? [[String: Any]] else { throw WorkerError("transcription_failed", "Whisper returned an invalid transcript.") }
        struct Word { var text: String; var points: [Int]; var originalEnd: Int; var itemIndex: Int }
        var words: [Word] = []
        for (itemIndex, item) in items.enumerated() {
            guard let tokens = item["tokens"] as? [[String: Any]] else { throw WorkerError("alignment_failed", "Whisper did not return DTW token alignment.") }
            let originalEnd = (item["offsets"] as? [String: Any])?["to"] as? Int ?? 0
            for token in tokens {
                guard let id = token["id"] as? Int, id >= 0, id < 50_257, let text = token["text"] as? String, !text.isEmpty else { continue }
                let point = (token["t_dtw"] as? NSNumber)?.doubleValue ?? -1
                let points = point.isFinite && point >= 0 && point < Double(Int.max / 10) ? [Int(point.rounded()) * 10] : []
                let cjk = text.unicodeScalars.contains { (0x3400...0x9fff).contains($0.value) || (0x3040...0x30ff).contains($0.value) || (0xac00...0xd7af).contains($0.value) }
                if words.isEmpty || text.first?.isWhitespace == true || cjk {
                    words.append(Word(text: text, points: points, originalEnd: originalEnd, itemIndex: itemIndex))
                } else {
                    words[words.count - 1].text += text
                    words[words.count - 1].points += points
                    words[words.count - 1].originalEnd = originalEnd
                    words[words.count - 1].itemIndex = itemIndex
                }
            }
        }
        guard words.allSatisfy({ !$0.points.isEmpty }) else { throw WorkerError("alignment_failed", "Whisper did not return usable DTW word alignment.") }
        var result: [[String: Any]] = [], pending = ""
        for (index, word) in words.enumerated() {
            let start = word.points[0]
            let end: Int
            if index + 1 < words.count {
                let next = words[index + 1]
                let nextStart = next.points[0]
                // A later utterance must not pull this word through a pause.
                end = next.itemIndex == word.itemIndex ? nextStart : min(nextStart, max(word.points.last ?? start, word.originalEnd))
            }
            else { end = max(word.points.last ?? start, word.originalEnd) }
            guard end >= start else { throw WorkerError("alignment_failed", "Whisper returned nonmonotonic DTW alignment.") }
            if start == end {
                if index + 1 < words.count || result.isEmpty { pending += word.text }
                else { result[result.count - 1]["text"] = (result[result.count - 1]["text"] as? String ?? "") + word.text }
                continue
            }
            result.append(["text": pending + word.text, "startMs": start, "endMs": end, "start": Double(start) / 1000, "end": Double(end) / 1000])
            pending = ""
        }
        guard pending.isEmpty else { throw WorkerError("alignment_failed", "Whisper did not return positive-duration DTW alignment.") }
        return result
    }
    static func segments(from object: [String: Any]) throws -> [[String: Any]] {
        guard let items = object["transcription"] as? [[String: Any]] else { throw WorkerError("transcription_failed", "Whisper returned an invalid transcript.") }
        var result: [[String: Any]] = []
        var pending = ""
        for segment in items {
            guard let text = segment["text"] as? String,
                  let offsets = segment["offsets"] as? [String: Any],
                  let start = offsets["from"] as? Int, let end = offsets["to"] as? Int,
                  start >= 0, end >= start else { throw WorkerError("transcription_failed", "Whisper returned invalid word timestamps.") }
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
            if end == start {
                if result.isEmpty { pending += text }
                else { result[result.count - 1]["text"] = (result[result.count - 1]["text"] as? String ?? "") + text }
                continue
            }
            result.append(["text": pending + text, "startMs": start, "endMs": end, "start": Double(start) / 1000, "end": Double(end) / 1000])
            pending = ""
        }
        guard pending.isEmpty else { throw WorkerError("transcription_failed", "Whisper did not return usable word timestamps.") }
        return result
    }
    static func executable() throws -> URL { try executable(named: "whisper-cli", override: "PACE_WHISPER_BIN") }
    static func executable(named: String, override: String) throws -> URL {
        var candidates: [String] = []
        if let path = ProcessInfo.processInfo.environment[override] { candidates.append(path) }
        if let path = ProcessInfo.processInfo.environment["PACE_BIN_DIR"] { candidates.append(URL(fileURLWithPath: path).appendingPathComponent(named).path) }
        let own = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
        candidates += [own.deletingLastPathComponent().appendingPathComponent(named).path, FileManager.default.currentDirectoryPath + "/native/bin/" + named]
        if let resources = Bundle.main.resourceURL { candidates.append(resources.appendingPathComponent(named).path) }
        guard let found = candidates.first(where: FileManager.default.isExecutableFile(atPath:)) else { throw WorkerError("runtime_missing", "\(named) is missing. Rebuild the native runtime.") }
        return URL(fileURLWithPath: found)
    }
}
