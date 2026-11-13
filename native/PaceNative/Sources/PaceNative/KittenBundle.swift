import Foundation
import CryptoKit

enum KittenBundle {
    static let modelID = "kitten-tts-micro-0.8"
    static let repository = "mlx-community/kitten-tts-micro-0.8"
    static let revision = "fd4e8e8677eafd21c5e92433f68532fcf156bd9c"
    static let g2pRepository = "beshkenadze/kitten-tts-g2p"
    static let g2pRevision = "9c692b92682d959d9013a9cfe6a49541997add18"
    static let g2pDirectory = "g2p-cache/mlx-audio/beshkenadze_kitten-tts-g2p"
    static let manifest = ModelManifest(repository: repository, revision: revision, files: [
        ModelFile(path: "config.json", size: 8144, sha256: nil, gitBlob: "68b440d0a151f9a2bb748ec93214569b50552dc0"),
        ModelFile(path: "model.safetensors", size: 133_248_108, sha256: "84fa9529deb16a0724ec237e6e76e33ad59dab5312b91b98c79bdff2d07de289", gitBlob: nil),
        ModelFile(path: "voices.npz", size: 3_278_902, sha256: "112710c1be8ad0e967c190fb0fd95cbe5848ec4791b93209f20b28b7da20dac1", gitBlob: nil),
        ModelFile(path: "README.md", size: 792, sha256: nil, gitBlob: "9fc276f393801762c477ab5f32feb95d4d3469cc"),
    ])
    static let g2pFiles: [ModelFile] = [
        resource("us_bart.safetensors", size: 3_011_692, sha256: "dc4a02e62d4fcb4bb4097ecf00db89b8e1a12a549a52ab6adfbba220b80a55c5"),
        resource("us_bart_config.json", size: 1257, gitBlob: "f6f03c4cb8deed1f2ff51ca861b83514854e324e"),
        resource("us_gold.json", size: 3_001_196, gitBlob: "a7c7b8aa19e0a6bb26db521ff540f6fd00f5b895"),
        resource("us_silver.json", size: 3_105_352, gitBlob: "f464207dc6b0bd5c785eae556fc6a16a53c0ee4b"),
        resource("README.md", size: 751, gitBlob: "ad1b074a44392adf2895d300e6ad4305573ef147"),
    ]

    private static func resource(_ name: String, size: Int64, sha256: String? = nil, gitBlob: String? = nil) -> ModelFile {
        ModelFile(path: "\(g2pDirectory)/\(name)", size: size, sha256: sha256, gitBlob: gitBlob,
                  sourceURL: "https://huggingface.co/\(g2pRepository)/resolve/\(g2pRevision)/\(name)")
    }

    static func convertVoices(in directory: URL) throws -> ModelFile {
        let temporary = directory.appendingPathComponent("voices-conversion-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temporary) }
        let unzip = Process()
        unzip.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        unzip.arguments = ["-x", "-k", directory.appendingPathComponent("voices.npz").path, temporary.path]
        unzip.standardOutput = FileHandle.nullDevice
        unzip.standardError = FileHandle.standardError
        try unzip.run(); unzip.waitUntilExit()
        guard unzip.terminationStatus == 0 else { throw WorkerError("invalid_model", "Kitten voice archive could not be unpacked.") }
        var tensors: [String: Any] = [:]
        var audio = Data()
        for number in 2...5 {
            for gender in ["f", "m"] {
                let key = "expr-voice-\(number)-\(gender)"
                let numpy = try Data(contentsOf: temporary.appendingPathComponent("\(key).npy"))
                let tensor = try voiceTensor(from: numpy)
                tensors[key] = ["dtype": "F32", "shape": [400, 256], "data_offsets": [audio.count, audio.count + tensor.count]]
                audio.append(tensor)
            }
        }
        var header = try JSONSerialization.data(withJSONObject: tensors, options: .sortedKeys)
        header.append(Data(repeating: 32, count: (8 - header.count % 8) % 8))
        var length = UInt64(header.count).littleEndian
        var data = withUnsafeBytes(of: &length) { Data($0) }
        data.append(header); data.append(audio)
        let destination = directory.appendingPathComponent("voices.safetensors")
        try data.write(to: destination, options: .atomic)
        return ModelFile(path: "voices.safetensors", size: Int64(data.count),
                         sha256: SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(), gitBlob: nil)
    }

    static func voiceTensor(from numpy: Data) throws -> Data {
        // shortcut: only this pinned NPZ's little-endian F32 [400, 256] format; revisit when upgrading Kitten.
        guard numpy.count >= 10, Array(numpy.prefix(8)) == [147, 78, 85, 77, 80, 89, 1, 0] else {
            throw WorkerError("invalid_model", "Unexpected Kitten voice tensor format.")
        }
        let offset = 10 + Int(numpy[8]) + (Int(numpy[9]) << 8)
        guard offset <= numpy.count, numpy.count - offset == 400 * 256 * 4,
              let header = String(data: numpy[10..<offset], encoding: .ascii),
              header.contains("'descr': '<f4'"), header.contains("'fortran_order': False"), header.contains("'shape': (400, 256)") else {
            throw WorkerError("invalid_model", "Unexpected Kitten voice tensor dimensions or dtype.")
        }
        return numpy.subdata(in: offset..<numpy.count)
    }
}
