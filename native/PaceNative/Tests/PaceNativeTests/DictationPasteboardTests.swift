import AppKit
import XCTest
@testable import PaceNative

final class DictationPasteboardTests: XCTestCase {
    private func board() -> NSPasteboard { NSPasteboard(name: .init("app.desktoppets.test.dictation.\(UUID().uuidString)")) }

    func testAllFormatsAndMultipleItemsRestoreWithoutFlattening() throws {
        let board = board(); defer { board.releaseGlobally() }
        let custom = NSPasteboard.PasteboardType("app.desktoppets.test.custom")
        let first = NSPasteboardItem(), second = NSPasteboardItem()
        first.setString("original", forType: .string)
        first.setData(Data([0, 1, 254]), forType: custom)
        second.setData(Data("{\\rtf1 saved}".utf8), forType: .rtf)
        XCTAssertTrue(board.writeObjects([first, second]))
        let snapshot = try DictationClipboardSnapshot(board)
        board.clearContents(); board.setString("temporary", forType: .string)
        XCTAssertTrue(snapshot.restore(board).restored)
        XCTAssertEqual(board.pasteboardItems?.count, 2)
        XCTAssertEqual(board.pasteboardItems?[0].data(forType: custom), Data([0, 1, 254]))
        XCTAssertEqual(board.pasteboardItems?[1].data(forType: .rtf), Data("{\\rtf1 saved}".utf8))
    }

    func testUnpreservableClipboardIsRejectedBeforeMutation() {
        let board = board(); defer { board.releaseGlobally() }
        let item = NSPasteboardItem()
        item.setData(Data(repeating: 1, count: 16 * 1024 * 1024 + 1), forType: .init("app.desktoppets.test.large"))
        XCTAssertTrue(board.writeObjects([item]))
        let count = board.changeCount
        XCTAssertThrowsError(try DictationClipboardSnapshot(board))
        XCTAssertEqual(board.changeCount, count)
        board.clearContents()
        let promise = NSPasteboardItem()
        promise.setData(Data("metadata".utf8), forType: .init("com.apple.pasteboard.promised-file-content-type"))
        XCTAssertTrue(board.writeObjects([promise]))
        let promiseCount = board.changeCount
        XCTAssertThrowsError(try DictationClipboardSnapshot(board))
        XCTAssertEqual(board.changeCount, promiseCount)
    }

    func testPromiseOwnershipIncludesChangeCountEvenWhenNewCopyHasIdenticalText() {
        let board = board(); defer { board.releaseGlobally() }
        let promise = DictationTranscriptPromise("dictated")
        XCTAssertTrue(promise.publish(board)); XCTAssertTrue(promise.owns(board))
        board.clearContents(); board.setString("dictated", forType: .string)
        XCTAssertFalse(promise.owns(board))
        XCTAssertNil(promise.readAt)
    }

    @MainActor
    func testUnreadPasteRetainsOriginalForExplicitOwnedRestoreWithoutRepeating() async throws {
        let board = board(); defer { board.releaseGlobally() }
        board.setString("original", forType: .string)
        let lease = DictationPasteboard(board, readBudget: 0.025, settle: 0, modifiersReleased: { true })
        var posts = 0
        let result = try await lease.paste("dictated", validate: { true }, verify: { nil }, post: { posts += 1 })
        XCTAssertEqual(posts, 1)
        XCTAssertEqual(result["dispatched"] as? Bool, true)
        XCTAssertEqual(result["clipboardRead"] as? Bool, false)
        XCTAssertEqual(result["inserted"] as? Bool, false)
        let id = try XCTUnwrap(result["clipboardRecoveryId"] as? String)
        XCTAssertEqual(board.string(forType: .string), "dictated")
        do { _ = try await lease.paste("second", validate: { true }, verify: { nil }, post: { posts += 1 }); XCTFail("Unread lease must prevent another paste") } catch {}
        XCTAssertEqual(posts, 1)
        XCTAssertEqual(try lease.restore(id)["restored"] as? Bool, true)
        XCTAssertEqual(board.string(forType: .string), "original")
    }

    @MainActor
    func testReadAcknowledgmentRestoresOnlyVerifiedTargetOtherwiseKeepsQuietRecovery() async throws {
        for verified in [true, false, nil] as [Bool?] {
            let board = board(); defer { board.releaseGlobally() }
            board.setString("original", forType: .string)
            let lease = DictationPasteboard(board, readBudget: 1, settle: 0.05, modifiersReleased: { true })
            let reader = Process(), output = Pipe()
            reader.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
            reader.arguments = ["--read-test-pasteboard", board.name.rawValue]
            reader.standardOutput = output
            let result = try await lease.paste("dictated", validate: { true }, verify: { verified }, post: {
                do { try reader.run() } catch { XCTFail("Named-pasteboard reader could not launch") }
            })
            reader.waitUntilExit()
            XCTAssertEqual(String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .newlines), "dictated")
            XCTAssertEqual(result["clipboardRead"] as? Bool, true)
            XCTAssertEqual(result["dispatched"] as? Bool, true)
            XCTAssertEqual(result["inserted"] as? Bool, verified == true)
            XCTAssertNil(result["insertionError"])
            if verified == true {
                XCTAssertEqual(board.string(forType: .string), "original")
                XCTAssertNil(result["clipboardRecoveryId"])
            } else {
                XCTAssertEqual(board.string(forType: .string), "dictated")
                let id = try XCTUnwrap(result["clipboardRecoveryId"] as? String)
                XCTAssertEqual(try lease.restore(id)["restored"] as? Bool, true)
                XCTAssertEqual(board.string(forType: .string), "original")
            }
        }
    }

    @MainActor
    func testFailedRestoreKeepsOriginalAndOwnershipForExplicitRetry() async throws {
        let board = board(); defer { board.releaseGlobally() }
        board.setString("original", forType: .string)
        var writes = 0
        let lease = DictationPasteboard(board, readBudget: 0.01, settle: 0, modifiersReleased: { true }, writeRestore: { board, items in
            writes += 1
            return writes == 1 ? false : board.writeObjects(items)
        })
        let result = try await lease.paste("dictated", validate: { true }, verify: { nil }, post: {})
        let id = try XCTUnwrap(result["clipboardRecoveryId"] as? String)
        XCTAssertThrowsError(try lease.restore(id))
        XCTAssertEqual(board.string(forType: .string), "dictated")
        XCTAssertEqual((lease.current()["recoveries"] as? [[String: String]])?.first?["recoveryId"], id)
        XCTAssertEqual(try lease.restore(id)["restored"] as? Bool, true)
        XCTAssertEqual(board.string(forType: .string), "original")
    }

    @MainActor
    func testFailedRestoreCannotReclaimANewerClipboardWrite() async throws {
        let board = board(); defer { board.releaseGlobally() }
        board.setString("original", forType: .string)
        let lease = DictationPasteboard(board, readBudget: 0.01, settle: 0, modifiersReleased: { true }, writeRestore: { board, _ in
            board.clearContents(); board.setString("new copy", forType: .string)
            return false
        })
        let result = try await lease.paste("dictated", validate: { true }, verify: { nil }, post: {})
        let id = try XCTUnwrap(result["clipboardRecoveryId"] as? String)
        XCTAssertThrowsError(try lease.restore(id))
        XCTAssertEqual(board.string(forType: .string), "new copy")
        XCTAssertEqual((lease.current()["recoveries"] as? [[String: String]])?.count, 0)
    }

    @MainActor
    func testNewerClipboardCopyIsNeverRestoredOver() async throws {
        let board = board(); defer { board.releaseGlobally() }
        board.setString("original", forType: .string)
        let lease = DictationPasteboard(board, readBudget: 0.01, settle: 0, modifiersReleased: { true })
        let result = try await lease.paste("dictated", validate: { true }, verify: { nil }, post: {})
        let id = try XCTUnwrap(result["clipboardRecoveryId"] as? String)
        board.clearContents(); board.setString("new copy", forType: .string)
        XCTAssertEqual(try lease.restore(id)["restored"] as? Bool, false)
        XCTAssertEqual(board.string(forType: .string), "new copy")
        XCTAssertEqual((lease.current()["recoveries"] as? [[String: String]])?.count, 0)
    }

    @MainActor
    func testCancellationAfterDispatchReturnsRecoveryWithoutRetryOrAutomaticRestore() async throws {
        let board = board(); defer { board.releaseGlobally() }
        board.setString("original", forType: .string)
        let lease = DictationPasteboard(board, modifiersReleased: { true })
        var posts = 0
        let task = Task { try await lease.paste("dictated", validate: { true }, verify: { nil }, post: { posts += 1 }) }
        try await Task.sleep(for: .milliseconds(30))
        task.cancel()
        let result = try await task.value
        XCTAssertEqual(posts, 1)
        XCTAssertEqual(result["dispatched"] as? Bool, true)
        XCTAssertEqual(result["verified"] as? Bool, false)
        XCTAssertNotNil(result["insertionError"])
        let id = try XCTUnwrap(result["clipboardRecoveryId"] as? String)
        XCTAssertEqual(board.string(forType: .string), "dictated")
        XCTAssertEqual(try lease.restore(id)["restored"] as? Bool, true)
        XCTAssertEqual(board.string(forType: .string), "original")
    }

    @MainActor
    func testConcurrentPasteAndStaleValidationNeverDispatchAgain() async throws {
        let board = board(); defer { board.releaseGlobally() }
        board.setString("original", forType: .string)
        let lease = DictationPasteboard(board, readBudget: 0.05, settle: 0, modifiersReleased: { true })
        var posts = 0
        let first = Task { try await lease.paste("one", validate: { true }, verify: { nil }, post: { posts += 1 }) }
        try await Task.sleep(for: .milliseconds(10))
        do { _ = try await lease.paste("two", validate: { true }, verify: { nil }, post: { posts += 1 }); XCTFail("Concurrent paste must be refused") } catch {}
        let result = try await first.value
        XCTAssertEqual(posts, 1)
        _ = try lease.restore(try XCTUnwrap(result["clipboardRecoveryId"] as? String))
        let count = board.changeCount
        do { _ = try await lease.paste("stale", validate: { false }, verify: { nil }, post: { posts += 1 }); XCTFail("Stale target must be refused") } catch {}
        XCTAssertEqual(posts, 1); XCTAssertEqual(board.changeCount, count)
    }

    func testModifierWaitIsBoundedAndNeverSynthesizesKeyReleases() async throws {
        var checks = 0
        try await waitForDictationModifiers(released: { checks += 1; return checks >= 2 })
        XCTAssertEqual(checks, 2)
        do { try await waitForDictationModifiers(timeout: .milliseconds(10), released: { false }); XCTFail("Held modifiers must time out") } catch { XCTAssertEqual((error as? BridgeError)?.code, "modifiers_held") }
    }
}
