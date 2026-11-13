import XCTest
@testable import PaceNative

final class DictationTests: XCTestCase {
    func testCursorInsertionPreservesPrefixSuffixAndUTF16Selection() {
        let value = "before 🐾 after"
        let range = NSRange(location: 7, length: 2)
        XCTAssertTrue(dictationTargetMatches(originalValue: value, currentValue: value, originalRange: range, currentRange: range))
        XCTAssertEqual((value as NSString).replacingCharacters(in: range, with: "Pace"), "before Pace after")
        let cursor = NSRange(location: 9, length: 0)
        XCTAssertTrue(dictationTargetMatches(originalValue: value, currentValue: value, originalRange: cursor, currentRange: cursor))
        XCTAssertEqual((value as NSString).replacingCharacters(in: cursor, with: "!"), "before 🐾! after")
    }

    func testChangedTextCursorAndInvalidRangesAreRejected() {
        let range = NSRange(location: 2, length: 0)
        XCTAssertFalse(dictationTargetMatches(originalValue: "hello", currentValue: "changed", originalRange: range, currentRange: range))
        XCTAssertFalse(dictationTargetMatches(originalValue: "hello", currentValue: "hello", originalRange: range, currentRange: NSRange(location: 3, length: 0)))
        for invalid in [NSRange(location: 100, length: 0), NSRange(location: 1, length: 0)] {
            XCTAssertFalse(dictationTargetMatches(originalValue: "🐾", currentValue: "🐾", originalRange: invalid, currentRange: invalid))
        }
    }

    func testCompletionContextKeepsCursorSidesAndClipsLargeFields() {
        XCTAssertEqual(completionContext(value: "before 🐾 after", range: NSRange(location: 7, length: 2)), ["before": "before ", "selected": "🐾", "after": " after"])
        let value = String(repeating: "a", count: 4000) + "🐾" + String(repeating: "b", count: 2000)
        let context = completionContext(value: value, range: NSRange(location: 4000, length: 2))
        XCTAssertEqual(context?["before"]?.count, 3000)
        XCTAssertEqual(context?["selected"], "🐾")
        XCTAssertEqual(context?["after"]?.count, 1000)
        XCTAssertNil(completionContext(value: "🐾", range: NSRange(location: 1, length: 0)))
    }
}
