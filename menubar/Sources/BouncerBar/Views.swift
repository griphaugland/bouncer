import AppKit
import ServiceManagement
import SwiftUI

extension Load {
    var color: Color {
        switch self {
        case .green: Color(nsColor: .systemGreen)
        case .yellow: Color(nsColor: .systemOrange)
        case .red: Color(nsColor: .systemRed)
        }
    }
}

// MARK: - Menu bar icon

/// A ring showing how much memory is in use. Monochrome when all is well (quiet), coloured
/// when it isn't, with the queue length beside it when something is waiting.
struct MenuBarLabel: View {
    let store: StatusStore

    var body: some View {
        let s = store.status
        HStack(spacing: 3) {
            Image(nsImage: ring(usedFraction: s.map { 1 - Double($0.freePercent) / 100 } ?? 0, load: s?.load))
            if let q = s?.queued.count, q > 0 {
                Text(String(q)).monospacedDigit()
            }
        }
    }

    /// A 270° gauge, open at the bottom like a dial: reads as "how full", never as a spinner.
    private func ring(usedFraction: Double, load: Load?) -> NSImage {
        let size = NSSize(width: 16, height: 16)
        let image = NSImage(size: size, flipped: false) { rect in
            let center = NSPoint(x: rect.midX, y: rect.midY)
            let radius = rect.width / 2 - 2
            let start: CGFloat = 225 // bottom-left
            let sweep: CGFloat = 270
            let quiet = load == nil || load == .green

            let track = NSBezierPath()
            track.appendArc(withCenter: center, radius: radius, startAngle: start, endAngle: start - sweep, clockwise: true)
            track.lineWidth = 2
            track.lineCapStyle = .round
            // Template images take one colour; alpha is what separates track from fill.
            (quiet ? NSColor.black.withAlphaComponent(0.3) : NSColor(white: 0.5, alpha: 0.45)).setStroke()
            track.stroke()

            if load != nil {
                let fill = NSBezierPath()
                let used = CGFloat(max(0.06, min(1, usedFraction)))
                fill.appendArc(withCenter: center, radius: radius, startAngle: start, endAngle: start - sweep * used, clockwise: true)
                fill.lineWidth = 2
                fill.lineCapStyle = .round
                switch load {
                case .yellow?: NSColor.systemOrange.setStroke()
                case .red?: NSColor.systemRed.setStroke()
                default: NSColor.black.setStroke()
                }
                fill.stroke()
            } else {
                // Daemon unreachable: an empty gauge, struck through.
                let slash = NSBezierPath()
                slash.move(to: NSPoint(x: rect.minX + 3.5, y: rect.minY + 3.5))
                slash.line(to: NSPoint(x: rect.maxX - 3.5, y: rect.maxY - 3.5))
                slash.lineWidth = 1.5
                slash.lineCapStyle = .round
                NSColor.black.setStroke()
                slash.stroke()
            }
            return true
        }
        // Template images follow the menu bar's light/dark appearance automatically.
        image.isTemplate = load == nil || load == .green
        image.accessibilityDescription = load.map { "Bouncer: \($0.title)" } ?? "Bouncer: not running"
        return image
    }
}

// MARK: - Popover

struct PopoverView: View {
    let store: StatusStore
    var sessionsExpanded = false
    /// Snapshot rendering: no ScrollView, which ImageRenderer can't draw.
    var forSnapshot = false

    private func sections(_ s: Status) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            if !s.advice.isEmpty { AdviceSection(advice: s.advice) }
            RunningSection(jobs: s.running, store: store)
            QueueSection(jobs: s.queued, store: store)
            if !s.external.isEmpty { ExternalSection(items: s.external) }
            SessionsSection(sessions: s.sessions, expanded: sessionsExpanded)
        }
        .padding(16)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let s = store.status {
                Header(status: s)
                    .padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 12)
                Divider()
                if forSnapshot {
                    sections(s)  // ImageRenderer cannot draw ScrollView content
                } else {
                    ScrollView { sections(s) }
                        .frame(maxHeight: 460)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                Unreachable(store: store)
            }
            Divider()
            Footer(store: store)
        }
        .frame(width: 380)
        .onAppear { store.isOpen = true }
        .onDisappear { store.isOpen = false }
    }
}

private struct Header: View {
    let status: Status

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Circle().fill(status.load.color).frame(width: 8, height: 8)
                Text(status.load.title).font(.title3.weight(.semibold))
                Spacer()
                Text("\(status.freePercent)% free")
                    .font(.callout).monospacedDigit().foregroundStyle(.secondary)
            }
            MemoryBar(freePercent: status.freePercent, load: status.load)
            Text(status.load.explanation).font(.caption).foregroundStyle(.secondary)
            HStack(spacing: 14) {
                ForEach(status.slots) { slot in SlotPips(slot: slot, outside: status.external.filter { $0.slot == slot.name }.count) }
                Spacer()
                Text("swap \(formatMb(status.swapUsedMb)) · disk \(status.diskFreeGb) GB")
                    .font(.caption).monospacedDigit().foregroundStyle(.tertiary)
            }
            .padding(.top, 2)
        }
    }
}

/// Used memory as a single bar. The only chart in the app: it answers "how close to the edge?".
private struct MemoryBar: View {
    let freePercent: Int
    let load: Load

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(.quaternary)
                Capsule().fill(load.color.opacity(load == .green ? 0.55 : 0.9))
                    .frame(width: geo.size.width * CGFloat(100 - freePercent) / 100)
            }
        }
        .frame(height: 5)
        .accessibilityLabel("\(100 - freePercent) percent of memory in use")
    }
}

/// One pip per seat: filled = a Bouncer job, orange = a build Bouncer didn't start, hollow = free.
private struct SlotPips: View {
    let slot: Slot
    let outside: Int

    var body: some View {
        HStack(spacing: 4) {
            Text(slot.name).font(.caption).foregroundStyle(.secondary)
            HStack(spacing: 2) {
                ForEach(0..<max(slot.capacity, slot.used + outside), id: \.self) { i in
                    Circle()
                        .fill(i < slot.used ? AnyShapeStyle(.primary)
                              : i < slot.used + outside ? AnyShapeStyle(Color(nsColor: .systemOrange))
                              : AnyShapeStyle(.quaternary))
                        .frame(width: 6, height: 6)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(slot.name): \(slot.used + outside) of \(slot.capacity) in use\(outside > 0 ? ", \(outside) outside Bouncer" : "")")
    }
}

private struct SectionTitle: View {
    let text: String
    var detail: String? = nil

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(text).font(.caption.weight(.semibold)).foregroundStyle(.secondary).textCase(.uppercase)
            if let detail { Text(detail).font(.caption).foregroundStyle(.tertiary) }
        }
    }
}

private struct AdviceSection: View {
    let advice: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionTitle(text: "Worth doing")
            ForEach(advice, id: \.self) { line in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "arrow.right").font(.caption2).foregroundStyle(.orange)
                    Text(line).font(.callout).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

private struct RunningSection: View {
    let jobs: [Job]
    let store: StatusStore

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionTitle(text: "Inside", detail: jobs.isEmpty ? nil : "\(jobs.count)")
            if jobs.isEmpty {
                Text("No heavy jobs running.").font(.callout).foregroundStyle(.tertiary)
            }
            ForEach(jobs) { job in
                JobRow(job: job, trailing: "\(formatMb(job.rssMb)) · \(formatDuration(seconds: job.elapsedMs / 1000))") {
                    RowAction(title: "Stop", systemImage: "stop.fill") { Task { await store.cancel(job: job.id) } }
                }
            }
        }
    }
}

private struct QueueSection: View {
    let jobs: [Job]
    let store: StatusStore

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionTitle(text: "In line", detail: jobs.isEmpty ? nil : "\(jobs.count)")
            if jobs.isEmpty {
                Text("Nobody waiting. When agents start builds faster than the Mac can take them, they line up here.")
                    .font(.callout).foregroundStyle(.tertiary).fixedSize(horizontal: false, vertical: true)
            }
            ForEach(jobs) { job in
                VStack(alignment: .leading, spacing: 2) {
                    JobRow(job: job, trailing: "#\(job.position ?? 0) · \(formatDuration(seconds: job.elapsedMs / 1000))") {
                        if job.priority != "high" {
                            RowAction(title: "Let in first", systemImage: "arrow.up.to.line") {
                                Task { await store.prioritize(job: job.id) }
                            }
                        }
                        RowAction(title: "Drop", systemImage: "xmark") { Task { await store.cancel(job: job.id) } }
                    }
                    if let reason = job.waitReason {
                        Text(reason).font(.caption).foregroundStyle(.secondary).padding(.leading, 18)
                    }
                }
            }
        }
    }
}

/// One job. Actions stay hidden until hover so the list reads as a list, not a toolbar.
private struct JobRow<Actions: View>: View {
    let job: Job
    let trailing: String
    @ViewBuilder let actions: () -> Actions
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 8) {
            // Fixed-width gutter so a prioritized row's columns line up with the rest.
            Image(systemName: "arrow.up").font(.caption2.weight(.bold)).foregroundStyle(.orange)
                .opacity(job.priority == "high" ? 1 : 0)
                .frame(width: 10)
                .help(job.priority == "high" ? "Prioritized" : "")
            Text(job.slot).font(.caption.monospaced()).foregroundStyle(.secondary).frame(width: 44, alignment: .leading)
            Text(job.cmd).font(.callout).lineLimit(1).truncationMode(.middle)
                .help("\(job.cmd)\n\(homeRelative(job.cwd))")
            Spacer(minLength: 6)
            if hovering {
                HStack(spacing: 2) { actions() }
            } else {
                Text(trailing).font(.caption).monospacedDigit().foregroundStyle(.secondary)
            }
        }
        .frame(minHeight: 22)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
    }
}

private struct RowAction: View {
    let title: String
    let systemImage: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: systemImage).labelStyle(.titleAndIcon).font(.caption)
        }
        .buttonStyle(PressableStyle())
    }
}

/// Subtle press feedback: the interface heard you.
private struct PressableStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(RoundedRectangle(cornerRadius: 5).fill(.quaternary.opacity(configuration.isPressed ? 1 : 0.6)))
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

private struct ExternalSection: View {
    let items: [External]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionTitle(text: "Outside", detail: "started without Bouncer, holding slots")
            ForEach(items) { e in
                HStack(spacing: 8) {
                    Text(e.slot).font(.caption.monospaced()).foregroundStyle(.secondary).frame(width: 44, alignment: .leading)
                    Text(e.shortCommand).font(.callout).lineLimit(1).truncationMode(.tail).help(e.command)
                    Spacer(minLength: 6)
                    Text("\(formatMb(e.rssMb)) · pid \(String(e.pid))").font(.caption).monospacedDigit().foregroundStyle(.secondary)
                }
            }
        }
    }
}

private struct SessionsSection: View {
    let sessions: [Session]
    @State var expanded = false

    var body: some View {
        let total = sessions.reduce(0) { $0 + $1.rssMb }
        let idle = sessions.filter { $0.idleSec >= 3600 }.count
        VStack(alignment: .leading, spacing: 6) {
            Button {
                expanded.toggle()
            } label: {
                HStack {
                    SectionTitle(text: "Sessions", detail: "\(sessions.count) · \(formatMb(total))\(idle > 0 ? " · \(idle) idle 1h+" : "")")
                    Spacer()
                    Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.caption2).foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if expanded {
                ForEach(sessions.prefix(12)) { s in
                    HStack(spacing: 8) {
                        Text(s.kind).font(.caption.monospaced()).foregroundStyle(.secondary).frame(width: 44, alignment: .leading)
                        Text(s.cwd.map { ($0 as NSString).lastPathComponent } ?? "pid \(String(s.pid))")
                            .font(.callout).lineLimit(1).truncationMode(.middle)
                            .help(homeRelative(s.cwd))
                        Spacer(minLength: 6)
                        Text("up \(formatDuration(seconds: s.elapsedSec))").font(.caption).monospacedDigit().foregroundStyle(.tertiary)
                            .frame(width: 64, alignment: .leading)
                        Text(s.idleSec >= 300 ? "idle \(formatDuration(seconds: s.idleSec))" : "active")
                            .font(.caption).foregroundStyle(s.idleSec >= 3600 ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
                            .frame(width: 72, alignment: .leading)
                        Text(formatMb(s.rssMb)).font(.caption).monospacedDigit().foregroundStyle(.secondary)
                            .frame(width: 56, alignment: .trailing)
                    }
                }
            }
        }
    }
}

private struct Unreachable: View {
    let store: StatusStore

    private static let installCommand = "brew install griphaugland/tap/bouncer && bouncer install"

    var body: some View {
        let notInstalled = store.problem == "Bouncer isn't installed."
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Circle().fill(notInstalled ? Color.secondary : Color(nsColor: .systemRed)).frame(width: 8, height: 8)
                Text(notInstalled ? "Bouncer isn't set up" : (store.problem ?? "Connecting…"))
                    .font(.title3.weight(.semibold))
            }
            if notInstalled {
                Text("This app shows Bouncer's queue. Install the command-line tool and its daemon first:")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                CommandBlock(command: Self.installCommand)
            } else {
                Text("Builds run unguarded until it's back. Nothing is blocked.")
                    .font(.callout).foregroundStyle(.secondary)
                HStack(spacing: 10) {
                    Button("Start Bouncer") { Task { await store.startDaemon() } }
                        .buttonStyle(PrimaryButtonStyle())
                        .keyboardShortcut(.defaultAction)
                    Text("or run bouncer doctor").font(.caption).foregroundStyle(.tertiary)
                }
                .padding(.top, 2)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A shell command the user is meant to copy, with a copy button that confirms itself.
private struct CommandBlock: View {
    let command: String
    @State private var copied = false

    var body: some View {
        HStack(spacing: 8) {
            Text(command)
                .font(.caption.monospaced())
                .textSelection(.enabled)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            Button {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(command, forType: .string)
                copied = true
                Task {
                    try? await Task.sleep(for: .seconds(1.5))
                    copied = false
                }
            } label: {
                Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                    .labelStyle(.titleAndIcon)
                    .font(.caption)
            }
            .buttonStyle(PressableStyle())
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 7).fill(.quaternary.opacity(0.5)))
    }
}

/// The one filled button in the app: the action that fixes the state you're looking at.
private struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout.weight(.medium))
            .foregroundStyle(.white)
            .padding(.horizontal, 12).padding(.vertical, 5)
            .background(RoundedRectangle(cornerRadius: 6).fill(Color.accentColor))
            .opacity(configuration.isPressed ? 0.85 : 1)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

/// Quiet text buttons for the footer: secondary until hovered.
private struct FooterButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        FooterLabel(configuration: configuration)
    }

    private struct FooterLabel: View {
        let configuration: ButtonStyleConfiguration
        @State private var hovering = false

        var body: some View {
            configuration.label
                .font(.caption)
                .foregroundStyle(hovering ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                .opacity(configuration.isPressed ? 0.6 : 1)
                .contentShape(Rectangle())
                .onHover { hovering = $0 }
        }
    }
}

private struct Footer: View {
    let store: StatusStore
    @State private var openAtLogin = SMAppService.mainApp.status == .enabled

    var body: some View {
        HStack(spacing: 14) {
            Button {
                setOpenAtLogin(!openAtLogin)
            } label: {
                Label("Open at login", systemImage: openAtLogin ? "checkmark.circle.fill" : "circle")
                    .labelStyle(.titleAndIcon)
            }
            .accessibilityValue(openAtLogin ? "on" : "off")
            Spacer()
            // Nothing to open before the CLI is installed.
            if store.problem != "Bouncer isn't installed." {
                Button("Log") { open(".bouncer/daemon.log") }
                Button("Policy") { open(".bouncer/policy.yaml") }
            }
            Button("Quit") { NSApp.terminate(nil) }.keyboardShortcut("q")
        }
        .buttonStyle(FooterButtonStyle())
        .padding(.horizontal, 16).padding(.vertical, 10)
    }

    private func open(_ relative: String) {
        NSWorkspace.shared.open(FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(relative))
    }

    private func setOpenAtLogin(_ on: Bool) {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {}
        openAtLogin = SMAppService.mainApp.status == .enabled
    }
}
