import Foundation

enum MoonshineBundle {
    static let revision = "d8d8fa29d05ca67441a7719e70099f9f48917a93"
    static let repository = "moonshine-ai/moonshine"
    static let languages = ["en", "zh", "ja", "es"]
    static let models: [ModelDefinition] = [
        model("en", name: "English", files: [
            ModelFile(path: "adapter.ort", size: 1_319_616, sha256: "c5f9f7cc98c27a965d8e200816f7e5c07b892712bb30cf07444bbde4ffd38199", gitBlob: nil, sourceURL: "https://download.moonshine.ai/model/tiny-streaming-en/quantized_26_11_02/adapter.ort"),
            ModelFile(path: "cross_kv.ort", size: 1_287_504, sha256: "5f68900da4ea20f40fbe67bbec36399f0d47faedbd7198b29abd9dc5f472ef9f", gitBlob: nil, sourceURL: "https://download.moonshine.ai/model/tiny-streaming-en/quantized_26_11_02/cross_kv.ort"),
            ModelFile(path: "decoder_kv.ort", size: 32_748_720, sha256: "6564f2c9a19de44195a53e336e07d05108f14babab57105d623bb68b79572d75", gitBlob: nil, sourceURL: "https://download.moonshine.ai/model/tiny-streaming-en/quantized_26_11_02/decoder_kv.ort"),
            ModelFile(path: "encoder.ort", size: 7_675_392, sha256: "617e403b2aae48f2474e0b148bf835deb9510bc8692efeabfe27203959a3256e", gitBlob: nil, sourceURL: "https://download.moonshine.ai/model/tiny-streaming-en/quantized_26_11_02/encoder.ort"),
            ModelFile(path: "frontend.model.ort", size: 23_392, sha256: "5662679f0e5758646d8eade3bc4b5d9ebda875feb6e696c0cc5f1a08fea2219e", gitBlob: nil, sourceURL: "https://download.moonshine.ai/model/tiny-streaming-en/quantized_26_11_02/frontend.model.ort"),
            ModelFile(path: "frontend.weights.ort", size: 2_093_416, sha256: "55c91d7efab9f7506d7d753131cba72145ff016be3447319fe414a31e13f25b4", gitBlob: nil, sourceURL: "https://download.moonshine.ai/model/tiny-streaming-en/quantized_26_11_02/frontend.weights.ort"),
            ModelFile(path: "streaming_config.json", size: 509, sha256: "74fe5ddebd63b17caf59e8a3b18c17547ff7bce1642050edbb1c3962674f8950", gitBlob: nil, sourceURL: "https://download.moonshine.ai/model/tiny-streaming-en/quantized_26_11_02/streaming_config.json"),
            ModelFile(path: "tokenizer.bin", size: 249_974, sha256: "6884b35fd6377d4c4d32336a0bc152f36b64d1e45b6503683cdc238250a8472d", gitBlob: nil, sourceURL: "https://download.moonshine.ai/model/tiny-streaming-en/quantized_26_11_02/tokenizer.bin"),
        ]),
        model("zh", name: "Chinese", files: [
            ModelFile(path: "adapter.ort", size: 1_318_472, sha256: "84d1bed88310f5b6dd452203bcaffb765f017a7d06da8d84a898235ef5c90e12", gitBlob: nil, sourceURL: "https://download.moonshine.ai/model/tiny-streaming-zh/quantized_26_08_24/adapter.ort"),
            ModelFile(path: "cross_kv.ort", size: 1_288_120, sha256: "22c2261f3120b766a91deceb4f32ca0bef0a8f2b181509ad0dc9fe6adbd0c23a", gitBlob: nil, sourceURL: "https://download.moonshine.ai/model/tiny-streaming-zh/quantized_26_08_24/cross_kv.ort"),
            ModelFile(path: "decoder_kv.ort", size: 19_717_336, sha256: "5caf9e4e9eaa39b93122338bfbad2917630afc51293f6229b935ae7df28bed33", gitBlob: nil, sourceURL: "https://download.moonshine.ai/model/tiny-streaming-zh/quantized_26_08_24/decoder_kv.ort"),
            ModelFile(path: "encoder.ort", size: 7_772_792, sha256: "4270ca0e1ecd10e78d658b08b91d81c7f913511177e1ad461c8a9d9d0903503d", gitBlob: nil, sourceURL: "https://download.moonshine.ai/model/tiny-streaming-zh/quantized_26_08_24/encoder.ort"),
            ModelFile(path: "frontend.model.ort", size: 27_608, sha256: "d27a9c994b43fa6568121f502e8b99d511ffd0425d4090ffddcc82c9a5667971", gitBlob: nil, sourceURL: "https://download.moonshine.ai/model/tiny-streaming-zh/quantized_26_08_24/frontend.model.ort"),
            ModelFile(path: "frontend.weights.ort", size: 2_090_728, sha256: "ac56e8ee7780e1f254ee26f2d9c9a3b3c6cfd2f6822cb3944924ae321f86dc50", gitBlob: nil, sourceURL: "https://download.moonshine.ai/model/tiny-streaming-zh/quantized_26_08_24/frontend.weights.ort"),
            ModelFile(path: "streaming_config.json", size: 509, sha256: "d31afd7c2dd5ee9ae3fa232312c5b42cb3e4fe1c6e9c53d885f2bea63023790a", gitBlob: nil, sourceURL: "https://download.moonshine.ai/model/tiny-streaming-zh/quantized_26_08_24/streaming_config.json"),
            ModelFile(path: "tokenizer.bin", size: 74_587, sha256: "f172da002a818b9968d5c7a995cc7c51acf2168331ab5f914b5b0860ceab8236", gitBlob: nil, sourceURL: "https://download.moonshine.ai/model/tiny-streaming-zh/quantized_26_08_24/tokenizer.bin"),
        ]),
        model("ja", name: "Japanese", files: [
            ModelFile(path: "adapter.ort", size: 1_318_472, sha256: "25f302e6203028e487d1b1f93db6fe5baf587373498062190160de70e0c4ae58", gitBlob: nil, sourceURL: "https://download.moonshine.ai/model/tiny-streaming-ja/quantized_26_08_23/adapter.ort"),
            ModelFile(path: "cross_kv.ort", size: 1_288_120, sha256: "170ee70aeb3c82fd067193add0d1a8619cd16d4de80a5e0239dac12d956e8575", gitBlob: nil, sourceURL: "https://download.moonshine.ai/model/tiny-streaming-ja/quantized_26_08_23/cross_kv.ort"),
            ModelFile(path: "decoder_kv.ort", size: 19_717_336, sha256: "ccc047610727f9fe039212a0b2370a7f970e80776376a229181a76998ff5af20", gitBlob: nil, sourceURL: "https://download.moonshine.ai/model/tiny-streaming-ja/quantized_26_08_23/decoder_kv.ort"),
            ModelFile(path: "encoder.ort", size: 7_772_792, sha256: "6420c180be55732d10db7a85f8966237bbbeee3b47addab4790ed81c22dde2cf", gitBlob: nil, sourceURL: "https://download.moonshine.ai/model/tiny-streaming-ja/quantized_26_08_23/encoder.ort"),
            ModelFile(path: "frontend.model.ort", size: 27_608, sha256: "c6fdee4c81d421617b9571e43cf952dc1e7e4f45d0cb1dbf13104ee8af4ffd45", gitBlob: nil, sourceURL: "https://download.moonshine.ai/model/tiny-streaming-ja/quantized_26_08_23/frontend.model.ort"),
            ModelFile(path: "frontend.weights.ort", size: 2_093_288, sha256: "673a7177f030da9ce948daa1af44ec5425b6f0825348aacb80f6a01c18e42a07", gitBlob: nil, sourceURL: "https://download.moonshine.ai/model/tiny-streaming-ja/quantized_26_08_23/frontend.weights.ort"),
            ModelFile(path: "streaming_config.json", size: 509, sha256: "d31afd7c2dd5ee9ae3fa232312c5b42cb3e4fe1c6e9c53d885f2bea63023790a", gitBlob: nil, sourceURL: "https://download.moonshine.ai/model/tiny-streaming-ja/quantized_26_08_23/streaming_config.json"),
            ModelFile(path: "tokenizer.bin", size: 101_836, sha256: "9f2599f20c3a9b03d79dbe122e443647c6589ce8e5c73e65e5c5d6f73485d5de", gitBlob: nil, sourceURL: "https://download.moonshine.ai/model/tiny-streaming-ja/quantized_26_08_23/tokenizer.bin"),
        ]),
        model("es", name: "Spanish", files: [
            ModelFile(path: "adapter.ort", size: 1_318_472, sha256: "2efd97cd2ee7d89578dd1d429a849be9fe37ac81dd9c4e1d31c8a2e7f85d43e6", gitBlob: nil, sourceURL: "https://download.moonshine.ai/model/tiny-streaming-es/quantized_26_08_24/adapter.ort"),
            ModelFile(path: "cross_kv.ort", size: 1_288_120, sha256: "9e268b1b3bb0f9ff79bca6e76055d41298de0a5ba52505ee04907a2642efa3ae", gitBlob: nil, sourceURL: "https://download.moonshine.ai/model/tiny-streaming-es/quantized_26_08_24/cross_kv.ort"),
            ModelFile(path: "decoder_kv.ort", size: 19_717_336, sha256: "7adf56b982df98e385d71823b9a40cf9296ae3a746efcf03f3d7bb4604032db0", gitBlob: nil, sourceURL: "https://download.moonshine.ai/model/tiny-streaming-es/quantized_26_08_24/decoder_kv.ort"),
            ModelFile(path: "encoder.ort", size: 7_772_792, sha256: "ec9eb43a01fbfe242a2c6a86050cffe4a31050e1c9f084e98560d6c100004505", gitBlob: nil, sourceURL: "https://download.moonshine.ai/model/tiny-streaming-es/quantized_26_08_24/encoder.ort"),
            ModelFile(path: "frontend.model.ort", size: 23_176, sha256: "9d19434b861de0c1d2aff52556911ae565cf3212ebe6d7f797c76c5c5066c2fc", gitBlob: nil, sourceURL: "https://download.moonshine.ai/model/tiny-streaming-es/quantized_26_08_24/frontend.model.ort"),
            ModelFile(path: "frontend.weights.ort", size: 2_093_280, sha256: "5e4d5471cd5d984d4b94a603d861539ebf1dc72de11b0cf13f38316725d5ce48", gitBlob: nil, sourceURL: "https://download.moonshine.ai/model/tiny-streaming-es/quantized_26_08_24/frontend.weights.ort"),
            ModelFile(path: "streaming_config.json", size: 509, sha256: "d31afd7c2dd5ee9ae3fa232312c5b42cb3e4fe1c6e9c53d885f2bea63023790a", gitBlob: nil, sourceURL: "https://download.moonshine.ai/model/tiny-streaming-es/quantized_26_08_24/streaming_config.json"),
            ModelFile(path: "tokenizer.bin", size: 102_888, sha256: "5fbb7d4314dcb18e03c5f975609e4a4cd572b22b01d2b2accb1b3e6830696f36", gitBlob: nil, sourceURL: "https://download.moonshine.ai/model/tiny-streaming-es/quantized_26_08_24/tokenizer.bin"),
        ]),
    ]

    private static func model(_ language: String, name: String, files: [ModelFile]) -> ModelDefinition {
        ModelDefinition(id: "moonshine-tiny-\(language)", name: "Moonshine Tiny · \(name)", role: "dictation", repo: repository,
                        sizeBytes: files.reduce(0) { $0 + $1.size }, pinnedManifest: ModelManifest(repository: repository, revision: revision, files: files))
    }

    static func language(_ value: String) -> String {
        value.lowercased().replacingOccurrences(of: "_", with: "-").split(separator: "-").first.map(String.init) ?? value
    }

    static func modelID(for language: String) -> String? {
        let normalized = self.language(language)
        return languages.contains(normalized) ? "moonshine-tiny-\(normalized)" : nil
    }

    static func vocabulary(_ value: Any?) throws -> [String] {
        guard let value else { return [] }
        guard let text = value as? String, text.count <= 4000, !text.contains("\0") else {
            throw WorkerError("invalid_params", "Custom vocabulary must contain at most 4000 characters.")
        }
        var seen = Set<String>()
        return text.components(separatedBy: CharacterSet.newlines.union(CharacterSet(charactersIn: ",")))
            .map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty && seen.insert($0).inserted }
    }
}
