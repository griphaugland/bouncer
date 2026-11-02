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

    private func ring(usedFraction: Double, load: Load?) -> NSImage {
        let size = NSSize(width: 16, height: 16)
        let image = NSImage(size: size, flipped: false) { rect in
            let inset = rect.insetBy(dx: 2, dy: 2)
            let track = NSBezierPath(ovalIn: inset)
            track.lineWidth = 2
            let quiet = load == nil || load == .green
            (quiet ? NSColor.black.withAlphaComponent(0.3) : NSColor.secondaryLabelColor).setStroke()
            track.stroke()

            let arc = NSBezierPath()
            let center = NSPoint(x: rect.midX, y: rect.midY)
            arc.appendArc(withCenter: center, radius: inset.width / 2, startAngle: 90,
                          endAngle: 90 - 360 * max(0.04, min(1, usedFraction)), clockwise: true)
            arc.lineWidth = 2
            arc.lineCapStyle = .round
            switch load {
            case .yellow?: NSColor.systemOrange.setStroke()
            case .red?: NSColor.systemRed.setStroke()
            default: NSColor.black.setStroke()
            }
            arc.stroke()
            if load == nil {
                // Daemon unreachable: a small slash through the ring.
                let slash = NSBezierPath()
                slash.move(to: NSPoint(x: inset.minX, y: inset.minY))
                slash.line(to: NSPoint(x: inset.maxX, y: inset.maxY))
                slash.lineWidth = 1.5
                NSColor.black.setStroke()
                slash.stroke()
            }
            return true
        }
        // Template images follow the menu bar's light/dark appearance automatically.
        image.isTemplate = load == nil || load == .green
        return image
    }
}

// MARK: - Popover

struct PopoverView: View {
    let store: StatusStore
    var sessionsExpanded = false
    /// Snapshot rendering: no ScrollView and no AppKit-backed controls, which ImageRenderer can't draw.
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
            if !forSnapshot {
                Divider()
                Footer(store: store)
            }
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

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(store.problem ?? "Connecting…").font(.title3.weight(.semibold))
            Text("Builds run unguarded until it's back. Nothing is blocked.")
                .font(.callout).foregroundStyle(.secondary)
            if store.problem == "Bouncer isn't running." {
                Button("Start Bouncer") { Task { await store.startDaemon() } }
                    .keyboardShortcut(.defaultAction)
            } else if store.problem == "Bouncer isn't installed." {
                Text("Run `bun run install-local` in the bouncer repo.").font(.caption.monospaced()).foregroundStyle(.secondary)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct Footer: View {
    let store: StatusStore
    @State private var openAtLogin = SMAppService.mainApp.status == .enabled

    var body: some View {
        HStack(spacing: 12) {
            Button("Log") {
                NSWorkspace.shared.open(FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".bouncer/daemon.log"))
            }
            Button("Policy") {
                NSWorkspace.shared.open(FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".bouncer/policy.yaml"))
            }
            Toggle("Open at login", isOn: $openAtLogin)
                .toggleStyle(.checkbox)
                .onChange(of: openAtLogin) { _, on in
                    do {
                        if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
                    } catch {
                        openAtLogin = SMAppService.mainApp.status == .enabled
                    }
                }
            Spacer()
            Button("Quit") { NSApp.terminate(nil) }.keyboardShortcut("q")
        }
        .buttonStyle(.link)
        .font(.caption)
        .padding(.horizontal, 16).padding(.vertical, 10)
    }
}
