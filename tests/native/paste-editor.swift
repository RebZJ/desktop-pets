import AppKit

// Local end-to-end target: real paste events, no messaging or network.
final class PasteEditor: NSTextView {
    var didPaste: (() -> Void)?
    override func paste(_ sender: Any?) {
        super.paste(sender)
        didPaste?()
    }
}

final class Fixture: NSObject, NSApplicationDelegate {
    let window = NSWindow(contentRect: NSRect(x: 140, y: 180, width: 560, height: 400), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    let editor = PasteEditor(frame: .zero)
    let other = NSTextField(string: "Other field stays unchanged")
    let result = NSTextField(labelWithString: "Paste events: 0")
    var pastes = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        window.title = "Pace native paste fixture"
        let root = NSStackView()
        root.orientation = .vertical
        root.alignment = .leading
        root.spacing = 14
        root.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        root.addArrangedSubview(NSTextField(labelWithString: "Local test editor. Nothing is sent."))
        let prepare = NSButton(title: "Prepare native paste target", target: self, action: #selector(prepare))
        root.addArrangedSubview(prepare)
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        editor.isRichText = true
        editor.isEditable = true
        editor.font = .systemFont(ofSize: 18)
        editor.setAccessibilityLabel("Native test editor")
        scroll.documentView = editor
        scroll.heightAnchor.constraint(equalToConstant: 150).isActive = true
        scroll.widthAnchor.constraint(equalToConstant: 510).isActive = true
        root.addArrangedSubview(scroll)
        other.setAccessibilityLabel("Other test field")
        other.widthAnchor.constraint(equalToConstant: 510).isActive = true
        root.addArrangedSubview(other)
        root.addArrangedSubview(NSButton(title: "Focus other field", target: self, action: #selector(focusOther)))
        root.addArrangedSubview(result)
        editor.didPaste = { [weak self] in
            guard let self else { return }
            self.pastes += 1
            self.result.stringValue = "Paste events: \(self.pastes)"
        }
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
        self.prepare()
    }

    @objc func prepare() {
        pastes = 0
        result.stringValue = "Paste events: 0"
        editor.string = "BEFORE  AFTER"
        NSApplication.shared.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(editor)
        editor.setSelectedRange(NSRange(location: 7, length: 0))
    }

    @objc func focusOther() {
        NSApplication.shared.activate(ignoringOtherApps: true)
        window.makeFirstResponder(other)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
let fixture = Fixture()
app.delegate = fixture
app.setActivationPolicy(.regular)
app.run()
