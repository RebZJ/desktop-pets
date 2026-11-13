import XCTest
@testable import PaceNative

final class DictationASRTests: XCTestCase {
    func testLanguagePacksNeverTurnAutomaticOrUnsupportedSpeechIntoEnglish() {
        XCTAssertEqual(MoonshineBundle.modelID(for: "en-AU"), "moonshine-tiny-en")
        XCTAssertEqual(MoonshineBundle.modelID(for: "zh_CN"), "moonshine-tiny-zh")
        XCTAssertEqual(MoonshineBundle.modelID(for: "ja"), "moonshine-tiny-ja")
        XCTAssertEqual(MoonshineBundle.modelID(for: "es"), "moonshine-tiny-es")
        XCTAssertNil(MoonshineBundle.modelID(for: "auto"))
        XCTAssertNil(MoonshineBundle.modelID(for: "de"))
    }

    func testCustomVocabularyPreservesPhrasesAndRejectsMalformedInput() throws {
        XCTAssertEqual(try MoonshineBundle.vocabulary("  Rebzj  \nAnushka Sharma\nRebzj,Ceph\n\n"), ["Rebzj", "Anushka Sharma", "Ceph"])
        XCTAssertEqual(try MoonshineBundle.vocabulary(nil), [])
        XCTAssertThrowsError(try MoonshineBundle.vocabulary(1))
        XCTAssertThrowsError(try MoonshineBundle.vocabulary("before\0after"))
        XCTAssertThrowsError(try MoonshineBundle.vocabulary(String(repeating: "a", count: 4001)))
    }

    func testPartialOrOutdatedPinnedPackCannotBeMarkedInstalled() throws {
        let model = try ModelDefinition.find("moonshine-tiny-en")
        let current = try XCTUnwrap(model.pinnedManifest)
        let incomplete = ModelManifest(repository: current.repository, revision: current.revision, files: Array(current.files.prefix(2)))
        XCTAssertFalse(ModelStore.manifestIncludesSupplements(incomplete, model: model))
        let oldFile = ModelFile(path: current.files[0].path, size: current.files[0].size, sha256: "outdated", gitBlob: nil)
        let old = ModelManifest(repository: current.repository, revision: "outdated", files: [oldFile] + Array(current.files.dropFirst()))
        XCTAssertFalse(ModelStore.manifestIncludesSupplements(old, model: model))
        let refreshed = ModelStore.addingSupplements(to: old, model: model)
        XCTAssertEqual(refreshed.revision, current.revision)
        XCTAssertTrue(ModelStore.manifestIncludesSupplements(refreshed, model: model))
    }
}
