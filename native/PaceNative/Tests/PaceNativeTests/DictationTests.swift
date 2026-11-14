import XCTest
import ApplicationServices
@testable import PaceNative

final class DictationTests: XCTestCase {
    func testWebFieldClassificationRequiresAWebAreaOrVerifiedNativeRoot() {
        let native = ["AXTextArea", "AXScrollArea", "AXWindow", kAXApplicationRole]
        XCTAssertEqual(dictationWebFieldClassification(0, role: { native[$0] }, parent: { $0 + 1 }), false)
        let web = ["AXTextArea", "AXGroup", "AXWebArea"]
        XCTAssertEqual(dictationWebFieldClassification(0, role: { web[$0] }, parent: { $0 + 1 }), true)
        XCTAssertNil(dictationWebFieldClassification(0, role: { _ in "AXTextArea" }, parent: { _ in nil as Int? }))
        XCTAssertNil(dictationWebFieldClassification(0, role: { _ in nil }, parent: { $0 + 1 }))
        XCTAssertNil(dictationWebFieldClassification(0, role: { _ in "AXGroup" }, parent: { $0 + 1 }))
    }

    func testUnicodeChunksPreserveGraphemesAndRejectCommandsBeforeAnyWrite() throws {
        let text = String(repeating: "a", count: 19) + "🐾e\u{301}👨‍👩‍👧‍👦" + String(repeating: "終", count: 27)
        let chunks = try dictationUnicodeChunks(text)
        XCTAssertEqual(chunks.joined(), text)
        XCTAssertTrue(chunks.allSatisfy { !$0.isEmpty && $0.utf16.count <= 20 })
        XCTAssertEqual(chunks.flatMap { Array($0) }, Array(text))
        for unsafe in ["", "safe\nsubmit", "safe\rsubmit", "safe\tswitch", "safe\0", "safe\u{7F}", "safe\u{2028}", "safe\u{F700}", "a" + String(repeating: "\u{301}", count: 20)] {
            XCTAssertThrowsError(try dictationUnicodeChunks(unsafe))
        }
    }

    func testUnicodeEventsContainExactUTF16WithoutModifiersOrReturn() throws {
        for chunk in try dictationUnicodeChunks("Hello 🐾 e\u{301} 👨‍👩‍👧‍👦! More than twenty units.") {
            let events = try XCTUnwrap(dictationUnicodeEvents(chunk))
            XCTAssertEqual(events.0.type, .keyDown)
            XCTAssertEqual(events.1.type, .keyUp)
            for event in [events.0, events.1] {
                XCTAssertEqual(event.flags, [])
                XCTAssertEqual(event.getIntegerValueField(.keyboardEventKeycode), 0x31)
                var units = [UniChar](repeating: 0, count: 20)
                var count = 0
                event.keyboardGetUnicodeString(maxStringLength: units.count, actualStringLength: &count, unicodeString: &units)
                XCTAssertEqual(Array(units.prefix(count)), Array(chunk.utf16))
            }
        }
    }
    @MainActor
    func testDelayedBrowserCommitConfirmsWithoutRepeatingTheWrite() async throws {
        var writes = 0, reads = 0
        let confirmed = try await performDictationWrite(write: { writes += 1; return .success }, confirm: {
            reads += 1
            return reads >= 3
        })
        XCTAssertTrue(confirmed)
        XCTAssertEqual(writes, 1)
        XCTAssertEqual(reads, 3)
    }

    @MainActor
    func testFailedOrUnconfirmedWritesAndChangedFocusAreNeverRetried() async throws {
        var writes = 0, reads = 0
        let refused = try await performDictationWrite(write: { writes += 1; return .cannotComplete }, confirm: { reads += 1; return true })
        XCTAssertFalse(refused); XCTAssertEqual(writes, 1); XCTAssertEqual(reads, 0)
        let unconfirmed = try await performDictationWrite(timeout: .milliseconds(25), write: { writes += 1; return .success }, confirm: { reads += 1; return false })
        XCTAssertFalse(unconfirmed); XCTAssertEqual(writes, 2); XCTAssertGreaterThan(reads, 1)
        do {
            _ = try await performDictationWrite(write: { writes += 1; return .success }, confirm: { throw BridgeError("stale_target", "Fixture focus changed") })
            XCTFail("Changed focus must stop confirmation")
        } catch { XCTAssertEqual((error as? BridgeError)?.code, "stale_target") }
        XCTAssertEqual(writes, 3)
    }
    func testInsertionPrefersSelectedTextAndRequiresValueAndCaretForFallback() {
        func unnecessaryProbe() -> Bool { XCTFail("The existing selected-text path must not probe fallback attributes"); return false }
        XCTAssertEqual(dictationInsertionAttribute(selectedTextWritable: true, valueWritable: unnecessaryProbe(), rangeWritable: unnecessaryProbe()), kAXSelectedTextAttribute)
        XCTAssertEqual(dictationInsertionAttribute(selectedTextWritable: false, valueWritable: true, rangeWritable: true), kAXValueAttribute)
        XCTAssertNil(dictationInsertionAttribute(selectedTextWritable: false, valueWritable: true, rangeWritable: false))
        XCTAssertNil(dictationInsertionAttribute(selectedTextWritable: false, valueWritable: false, rangeWritable: unnecessaryProbe()))
    }
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
