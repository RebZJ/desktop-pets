import AppKit
import WebKit

// Local WebKit insertion targets; no networking, OS input automation or clipboard access.
final class WebFixture: NSObject, NSApplicationDelegate {
    let window = NSWindow(contentRect: NSRect(x: 160, y: 180, width: 720, height: 650), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    let web: WKWebView = {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        return WKWebView(frame: .zero, configuration: configuration)
    }()

    func applicationDidFinishLaunching(_ notification: Notification) {
        window.title = "Pace WebKit paste fixture"
        let root = NSStackView()
        root.orientation = .vertical
        root.alignment = .leading
        root.spacing = 10
        root.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        root.addArrangedSubview(NSTextField(labelWithString: "Local WebKit test editors. Nothing is sent."))
        for (title, selector) in [
            ("Prepare plain web target", #selector(preparePlain)),
            ("Prepare rich web target", #selector(prepareRich)),
            ("Prepare reactive web target", #selector(prepareReactive)),
        ] {
            root.addArrangedSubview(NSButton(title: title, target: self, action: selector))
        }
        web.widthAnchor.constraint(equalToConstant: 680).isActive = true
        web.heightAnchor.constraint(equalToConstant: 460).isActive = true
        root.addArrangedSubview(web)
        window.contentView = root
        let menu = NSMenu()
        let application = NSMenuItem()
        application.submenu = NSMenu()
        application.submenu?.addItem(withTitle: "Quit fixture", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(application)
        let edit = NSMenuItem()
        edit.submenu = NSMenu(title: "Edit")
        edit.submenu?.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        menu.addItem(edit)
        NSApplication.shared.mainMenu = menu
        web.loadHTMLString(Self.html, baseURL: nil)
        window.makeKeyAndOrderFront(nil)
    }

    func prepare(_ field: String) {
        NSApplication.shared.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(web)
        web.evaluateJavaScript("prepare('\(field)')", completionHandler: nil)
    }

    @objc func preparePlain() { prepare("plain") }
    @objc func prepareRich() { prepare("rich") }
    @objc func prepareReactive() { prepare("reactive") }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    static let html = #"""
    <!doctype html>
    <html lang="en"><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
    <style>
    body { margin: 12px; font: 16px system-ui; }
    label { display: block; margin-top: 12px; }
    textarea, [contenteditable] { box-sizing: border-box; width: 100%; min-height: 62px; padding: 8px; border: 1px solid #777; font: 18px system-ui; white-space: pre-wrap; }
    [role=status] { display: block; margin-top: 4px; font-size: 13px; }
    </style></head><body>
    <label for="plain">Plain web test editor</label>
    <textarea id="plain" aria-label="Plain web test editor">BEFORE  AFTER</textarea>
    <span id="plain-count" role="status" aria-label="Plain web input event counter">Plain input events: 0</span>
    <label for="rich">Rich web test editor</label>
    <div id="rich" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Rich web test editor"><span>BEFORE </span><strong>BOLD</strong><span> AFTER</span></div>
    <span id="rich-count" role="status" aria-label="Rich web input event counter">Rich input events: 0</span>
    <label for="reactive">Reactive web test editor</label>
    <div id="reactive" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Reactive web test editor">BEFORE  AFTER</div>
    <span id="reactive-count" role="status" aria-label="Reactive web input event counter">Reactive input events: 0</span>
    <script>
    const counts = { plain: 0, rich: 0, reactive: 0 };
    const names = { plain: 'Plain', rich: 'Rich', reactive: 'Reactive' };
    function count(id) {
      document.getElementById(id + '-count').textContent = names[id] + ' input events: ' + counts[id];
    }
    function caret(field, offset) {
      const walker = document.createTreeWalker(field, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (offset <= node.length) {
          const range = document.createRange();
          range.setStart(node, offset);
          range.collapse(true);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          return;
        }
        offset -= node.length;
      }
    }
    function prepare(id) {
      const field = document.getElementById(id);
      counts[id] = 0;
      count(id);
      if (id === 'plain') field.value = 'BEFORE  AFTER';
      else if (id === 'rich') field.innerHTML = '<span>BEFORE </span><strong>BOLD</strong><span> AFTER</span>';
      else field.textContent = 'BEFORE  AFTER';
      field.focus();
      if (id === 'plain') field.setSelectionRange(7, 7);
      else caret(field, 7);
    }
    for (const id of Object.keys(counts)) {
      document.getElementById(id).addEventListener('input', () => {
        counts[id]++;
        count(id);
        if (id !== 'reactive') return;
        queueMicrotask(() => {
          const field = document.getElementById(id);
          const selection = window.getSelection();
          let offset = null;
          if (document.activeElement === field && selection.rangeCount && field.contains(selection.focusNode)) {
            const range = document.createRange();
            range.selectNodeContents(field);
            range.setEnd(selection.focusNode, selection.focusOffset);
            offset = range.toString().length;
          }
          field.replaceChildren(document.createTextNode(field.textContent));
          if (offset !== null) caret(field, offset);
        });
      });
    }
    </script></body></html>
    """#
}

let app = NSApplication.shared
let fixture = WebFixture()
app.delegate = fixture
app.setActivationPolicy(.regular)
app.run()
