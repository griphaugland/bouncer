import AppKit
import SwiftUI

@main
struct BouncerBarApp: App {
    @State private var store = StatusStore()

    init() {
        // `BouncerBar --snapshot <dir>` renders the popover with live data to PNGs and exits.
        // Design QA without screen-recording permission.
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--snapshot"), i + 1 < args.count {
            Snapshot.render(to: URL(fileURLWithPath: args[i + 1]))
            exit(0)
        }
    }

    var body: some Scene {
        MenuBarExtra {
            PopoverView(store: store)
        } label: {
            MenuBarLabel(store: store)
                .task { store.start() }
        }
        .menuBarExtraStyle(.window)
    }
}

@MainActor
enum Snapshot {
    static func render(to dir: URL) {
        let store = StatusStore()
        let sem = DispatchSemaphore(value: 0)
        Task.detached {
            await store.refresh()
            sem.signal()
        }
        while sem.wait(timeout: .now()) == .timedOut {
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        for (name, scheme) in [("light", ColorScheme.light), ("dark", ColorScheme.dark)] {
            let view = PopoverView(store: store, sessionsExpanded: true, forSnapshot: true)
                .background(Color(nsColor: .windowBackgroundColor))
                .environment(\.colorScheme, scheme)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            guard let image = renderer.nsImage,
                  let tiff = image.tiffRepresentation,
                  let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:])
            else { continue }
            try? png.write(to: dir.appendingPathComponent("popover-\(name).png"))
        }
        print("wrote \(dir.path)/popover-{light,dark}.png")
    }
}
