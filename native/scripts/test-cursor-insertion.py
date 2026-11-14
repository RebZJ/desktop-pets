#!/usr/bin/env python3
"""Test real AX cursor insertion in disposable AppKit windows; never edit an existing app.

Requires macOS, Swift, and Accessibility permission for the terminal/host running this script.
Compiles production Bridge.swift + Dictation.swift with unused meeting/diarization stubs.
"""
import json
import pathlib
import plistlib
import select
import subprocess
import tempfile
import time
ROOT = pathlib.Path(__file__).resolve().parents[2]
swift = '''import AppKit
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let stateURL = URL(fileURLWithPath: CommandLine.arguments[1])
let commandURL = URL(fileURLWithPath: CommandLine.arguments[2])
let window = NSWindow(contentRect:NSRect(x:200,y:200,width:500,height:220),styleMask:[.titled,.closable],backing:.buffered,defer:false)
window.title = "Pace synthetic dictation fixture"
let text = NSTextView(frame:NSRect(x:12,y:12,width:476,height:196))
text.isRichText = false
text.string = "before 🐾 after"
window.contentView?.addSubview(text)
window.makeKeyAndOrderFront(nil)
window.makeFirstResponder(text)
text.setSelectedRange(NSRange(location:7,length:2))
app.activate(ignoringOtherApps:true)
let timer = Timer.scheduledTimer(withTimeInterval:0.05,repeats:true) { _ in
    if let raw = try? Data(contentsOf:commandURL), let command = try? JSONSerialization.jsonObject(with:raw) as? [String:Any] {
        try? FileManager.default.removeItem(at:commandURL)
        if let value = command["text"] as? String { text.string = value }
        if let location = command["location"] as? Int { text.setSelectedRange(NSRange(location:location,length:command["length"] as? Int ?? 0)) }
        if command["activate"] as? Bool == true { window.makeKeyAndOrderFront(nil); app.activate(ignoringOtherApps:true) }
    }
    let state:[String:Any] = ["text":text.string,"location":text.selectedRange().location,"length":text.selectedRange().length,"active":app.isActive]
    if let raw = try? JSONSerialization.data(withJSONObject:state) { try? raw.write(to:stateURL,options:.atomic) }
}
app.run()
'''
helper_source = '''import AppKit
@MainActor enum MeetingService {
    static func handle(method: String, params: [String: Any], emit: @escaping ([String: Any]) -> Void) async throws -> [String: Any]? { nil }
}
@MainActor enum DiarizationService {
    static func handle(method: String, params: [String: Any], emit: @escaping ([String: Any]) -> Void) async throws -> [String: Any]? { nil }
}
@main struct Helper {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        DispatchQueue.global().async {
            while let line = readLine(), let raw = line.data(using:.utf8), let input = try? JSONSerialization.jsonObject(with:raw) as? [String:Any] {
                Task { @MainActor in
                    var reply:[String:Any] = ["id":input["id"] ?? ""]
                    do { reply["result"] = try await BridgeService.handle(method:input["method"] as? String ?? "", params:input["params"] as? [String:Any] ?? [:],emit:{_ in}) }
                    catch { reply["error"] = ["code":(error as? BridgeError)?.code ?? "error","message":error.localizedDescription] }
                    if let data = try? JSONSerialization.data(withJSONObject:reply) { FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10])) }
                }
            }
        }
        app.run()
    }
}
'''
with tempfile.TemporaryDirectory(prefix='pace-synthetic-cursor-') as folder:
    d = pathlib.Path(folder)
    source = d / 'main.swift'
    source.write_text(swift)
    bundle = d / 'Fixture.app'
    mac = bundle / 'Contents/MacOS'
    mac.mkdir(parents=True)
    (bundle / 'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier': 'app.desktoppets.syntheticdictation', 'CFBundleName': 'Synthetic Dictation Fixture', 'CFBundleExecutable': 'Fixture', 'CFBundlePackageType': 'APPL'}))
    subprocess.run(['swiftc', str(source), '-o', str(mac / 'Fixture')], check=True, capture_output=True)
    helper = d / 'BridgeHelper.swift'
    helper.write_text(helper_source)
    subprocess.run(['swiftc', '-swift-version', '5', str(ROOT / 'native/PaceNative/Sources/PaceNative/Bridge.swift'), str(ROOT / 'native/PaceNative/Sources/PaceNative/Dictation.swift'), str(ROOT / 'native/PaceNative/Sources/PaceNative/DictationPasteboard.swift'), str(helper), '-o', str(d / 'bridge-helper')], check=True, capture_output=True)
    host = subprocess.Popen([str(mac / 'Fixture'), str(d / 'state'), str(d / 'command')], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    worker = subprocess.Popen([str(d / 'bridge-helper')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)

    def request(method, params={}):
        rid = str(time.monotonic_ns())
        worker.stdin.write(json.dumps({'id': rid, 'method': method, 'params': params}) + '\n')
        worker.stdin.flush()
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if not select.select([worker.stdout], [], [], max(0, deadline - time.monotonic()))[0]:
                raise TimeoutError(method)
            line = worker.stdout.readline()
            if not line:
                raise RuntimeError('Worker stopped')
            data = json.loads(line)
            if data.get('id') == rid:
                return data
        raise TimeoutError(method)

    def state():
        return json.loads((d / 'state').read_text())

    def wait_for(predicate):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            try:
                value = state()
                if predicate(value):
                    return value
            except (FileNotFoundError, json.JSONDecodeError):
                pass
            time.sleep(0.05)
        raise AssertionError('Fixture state timeout')

    def change(**params):
        (d / 'command').write_text(json.dumps(params))
        wait_for(lambda s: all((s.get(k) == v for k, v in params.items())))
    other = subprocess.Popen([str(mac / 'Fixture'), str(d / 'other-state'), str(d / 'other-command')], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        (d / 'command').write_text(json.dumps({'activate': True}))
        wait_for(lambda s: s['active'])
        assert request('permissions.status')['result']['accessibility'] == 'granted', 'Enable Accessibility for your terminal/host, then rerun.'
        capture = request('completion.capture')
        print('capture', json.dumps(capture))
        context = capture['result']
        assert context['before'] == 'before ' and context['selected'] == '🐾' and (context['after'] == ' after')
        assert context.get('bounds', {}).get('height', 0) > 0, context
        (d / 'other-command').write_text(json.dumps({'activate': True}))
        wait_for(lambda s: not s['active'])
        inserted = request('completion.apply', {'targetId': context['targetId'], 'text': 'Pace'})
        assert inserted.get('result', {}).get('applied'), inserted
        wait_for(lambda s: s['active'] and s['text'] == 'before Pace after')
        print('PASS explicit Accept restores source app focus and preserves surrounding text')
        reused = request('completion.apply', {'targetId': context['targetId'], 'text': 'duplicate'})
        assert reused['error']['code'] == 'invalid_target', reused
        print('PASS completion target single use')
        target = request('completion.capture')['result']['targetId']
        change(location=0, length=0)
        stale = request('completion.apply', {'targetId': target, 'text': 'SHOULD NOT APPEAR'})
        assert stale['error']['code'] == 'stale_target', stale
        assert state()['text'] == 'before Pace after'
        print('PASS stale cursor acceptance rejected without modifying field')
        target = request('completion.capture')['result']['targetId']
        change(text='Synthetic changed field', location=0)
        stale = request('completion.apply', {'targetId': target, 'text': 'SHOULD NOT APPEAR'})
        assert stale['error']['code'] == 'stale_target', stale
        assert state()['text'] == 'Synthetic changed field'
        print('PASS stale field acceptance rejected without modifying field')
        target = request('dictation.capture')['result']['targetId']
        completion = request('completion.capture')['result']['targetId']
        request('completion.dismiss', {'targetId': completion})
        inserted = request('dictation.insert', {'targetId': target, 'text': 'Independent '})
        assert inserted.get('result', {}).get('inserted'), inserted
        wait_for(lambda s: s['text'] == 'Independent Synthetic changed field')
        print('PASS completion target capture/dismiss does not clobber dictation target')
        target = request('dictation.capture')['result']['targetId']
        (d / 'other-command').write_text(json.dumps({'activate': True}))
        wait_for(lambda s: not s['active'])
        refused = request('dictation.insert', {'targetId': target, 'text': 'SHOULD NOT APPEAR'})
        assert refused['error']['code'] == 'stale_target', refused
        assert state()['text'] == 'Independent Synthetic changed field'
        print('PASS dictation refuses focus restoration and leaves background field untouched')
    finally:
        worker.terminate()
        host.terminate()
        other.terminate()
        worker.wait(timeout=8)
        host.wait(timeout=8)
        other.wait(timeout=8)
