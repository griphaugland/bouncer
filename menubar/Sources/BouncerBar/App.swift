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
            let fixture = args.firstIndex(of: "--status-file").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil }
            Snapshot.render(to: URL(fileURLWithPath: args[i + 1]), fixture: fixture.map { URL(fileURLWithPath: $0) })
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
    /// `--status-file`: a status JSON fixture, or `not-running` / `not-installed` for those states.
    /// Writes popover-<name>-{light,dark}.png and icon-<name>.png into `dir`.
    static func render(to dir: URL, fixture: URL?) {
        let store = StatusStore()
        var name = "live"
        if let fixture {
            switch fixture.lastPathComponent {
            case "not-running":
                store.simulate(problem: "Bouncer isn't running.")
                name = "not-running"
            case "not-installed":
                store.simulate(problem: "Bouncer isn't installed.")
                name = "not-installed"
            default:
                do { try store.load(fixture: fixture) } catch { print("bad --status-file: \(error)"); exit(1) }
                name = fixture.deletingPathExtension().lastPathComponent.replacingOccurrences(of: "demo-status-", with: "")
                    .replacingOccurrences(of: "demo-status", with: "demo")
            }
        } else {
            let sem = DispatchSemaphore(value: 0)
            Task.detached {
                await store.refresh()
                sem.signal()
            }
            while sem.wait(timeout: .now()) == .timedOut {
                RunLoop.main.run(until: Date().addingTimeInterval(0.05))
            }
        }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        for (suffix, scheme) in [("light", ColorScheme.light), ("dark", ColorScheme.dark)] {
            let view = PopoverView(store: store, sessionsExpanded: true, forSnapshot: true)
                .background(Color(nsColor: .windowBackgroundColor))
                .environment(\.colorScheme, scheme)
            write(view, scale: 2, to: dir.appendingPathComponent("popover-\(name)-\(suffix).png"))
        }
        // The menu bar item on a light and a dark bar, magnified so the 16 pt ring is reviewable.
        let bar = HStack(spacing: 0) {
            ForEach([ColorScheme.light, .dark], id: \.self) { scheme in
                MenuBarLabel(store: store)
                    .padding(.horizontal, 10).padding(.vertical, 4)
                    .background(scheme == .light ? Color(white: 0.93) : Color(white: 0.16))
                    .environment(\.colorScheme, scheme)
                    .foregroundStyle(scheme == .light ? Color.black : Color.white)
            }
        }
        write(bar, scale: 6, to: dir.appendingPathComponent("icon-\(name).png"))
        print("wrote \(dir.path)/{popover-\(name)-light,popover-\(name)-dark,icon-\(name)}.png")
    }

    private static func write(_ view: some View, scale: CGFloat, to url: URL) {
        let renderer = ImageRenderer(content: view)
        renderer.scale = scale
        guard let image = renderer.nsImage,
              let tiff = image.tiffRepresentation,
              let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:])
        else { return }
        try? png.write(to: url)
    }
}
