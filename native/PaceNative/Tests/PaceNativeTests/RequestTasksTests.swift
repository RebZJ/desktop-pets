import XCTest
@testable import PaceNative

private actor PermissionGate {
    private var answer: CheckedContinuation<Bool, Never>?
    private var waiting: CheckedContinuation<Void, Never>?

    func request() async -> Bool {
        await withCheckedContinuation { answer in
            self.answer = answer
            waiting?.resume(); waiting = nil
        }
    }

    func waitUntilRequested() async {
        if answer != nil { return }
        await withCheckedContinuation { waiting = $0 }
    }

    func grant() { answer?.resume(returning: true); answer = nil }
}

final class RequestTasksTests: XCTestCase {
    func testStoppedAutomaticSpeechCannotArriveAfterTheStop() {
        let tasks = RequestTasks()
        XCTAssertTrue(tasks.acceptAutomaticSpeech(1))
        tasks.advanceSpeechEpoch(2)
        XCTAssertFalse(tasks.acceptAutomaticSpeech(1))
        XCTAssertTrue(tasks.acceptAutomaticSpeech(2))
        XCTAssertTrue(tasks.acceptAutomaticSpeech(3))
        tasks.advanceSpeechEpoch(2)
        XCTAssertFalse(tasks.acceptAutomaticSpeech(2))
    }
    func testScopedCancellationBeforeLatePermissionGrantNeverStartsCapture() async {
        let tasks = RequestTasks()
        let cancelledGate = PermissionGate()
        let otherGate = PermissionGate()
        let cancelled = expectation(description: "cancelled request completed")
        let other = expectation(description: "unrelated request still starts")
        let forbidden = expectation(description: "cancelled capture must not start")
        forbidden.isInverted = true
        XCTAssertTrue(tasks.start(id: "timed-out-mic", method: "audio.start") {
            do {
                _ = try await capturePermission { await cancelledGate.request() }
                forbidden.fulfill()
            } catch { XCTAssertTrue(error is CancellationError); cancelled.fulfill() }
        })
        XCTAssertTrue(tasks.start(id: "unrelated", method: "meeting.start") {
            do {
                _ = try await capturePermission { await otherGate.request() }
                other.fulfill()
            } catch { XCTFail("Unrelated capture was cancelled") }
        })
        await cancelledGate.waitUntilRequested()
        await otherGate.waitUntilRequested()
        XCTAssertEqual(tasks.cancel(id: "timed-out-mic"), 1)
        await cancelledGate.grant()
        await otherGate.grant()
        await fulfillment(of: [cancelled, other, forbidden], timeout: 0.2)
    }

    func testEOFShutdownCancelsPendingPermissionAndRejectsNewRequests() async {
        let tasks = RequestTasks()
        let gate = PermissionGate()
        let cancelled = expectation(description: "pending permission cancelled on EOF")
        let forbidden = expectation(description: "capture must not start after EOF")
        forbidden.isInverted = true
        XCTAssertTrue(tasks.start(id: "pending", method: "audio.start") {
            do {
                _ = try await capturePermission { await gate.request() }
                forbidden.fulfill()
            } catch { XCTAssertTrue(error is CancellationError); cancelled.fulfill() }
        })
        await gate.waitUntilRequested()
        tasks.shutdown()
        XCTAssertFalse(tasks.start(id: "after-eof", method: "audio.start") { forbidden.fulfill() })
        await gate.grant()
        await fulfillment(of: [cancelled, forbidden], timeout: 0.2)
    }
}
