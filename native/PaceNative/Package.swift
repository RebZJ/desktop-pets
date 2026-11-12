// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "PaceNative",
    platforms: [.macOS(.v15)],
    dependencies: [
        .package(url: "https://github.com/ml-explore/mlx-swift-lm.git", revision: "6352907543270ae9c61fcaf59cb3e07b0b989ea1", traits: []),
        .package(url: "https://github.com/Neywa-Labs/mlx-audio-swift.git", exact: "0.1.8"),
        .package(url: "https://github.com/huggingface/swift-transformers.git", from: "1.3.0"),
        .package(url: "https://github.com/huggingface/swift-huggingface.git", from: "0.9.0"),
    ],
    targets: [
        .executableTarget(name: "PaceNative", dependencies: [
            .product(name: "MLXLLM", package: "mlx-swift-lm"),
            .product(name: "MLXLMCommon", package: "mlx-swift-lm"),
            .product(name: "MLXHuggingFace", package: "mlx-swift-lm"),
            .product(name: "MLXAudioTTS", package: "mlx-audio-swift"),
            .product(name: "MLXAudioCore", package: "mlx-audio-swift"),
            .product(name: "Tokenizers", package: "swift-transformers"),
            .product(name: "HuggingFace", package: "swift-huggingface"),
        ]),
        .testTarget(name: "PaceNativeTests", dependencies: ["PaceNative"]),
    ],
    swiftLanguageModes: [.v5]
)
