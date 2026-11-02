import Foundation
import Observation

/// Polls the daemon through the `bouncer` CLI. The CLI is the API: the menu bar never speaks
/// the socket protocol itself, so there is exactly one implementation of it.
@MainActor
@Observable
final class StatusStore {
    private(set) var status: Status?
    private(set) var problem: String?
    private(set) var lastUpdated: Date?

    /// Polled fast while the popover is open, slowly otherwise (the icon only needs the load).
    var isOpen = false {
        didSet { if isOpen { Task { await refresh() } } }
    }

    static let binary = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".bouncer/bouncer").path

    private var loop: Task<Void, Never>?

    func start() {
        guard loop == nil else { return }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                let open = self?.isOpen ?? false
                try? await Task.sleep(for: open ? .seconds(2) : .seconds(5))
            }
        }
    }

    func refresh() async {
        let result = await Self.run(["status", "--json"])
        lastUpdated = Date()
        guard result.code == 0, let data = result.stdout.data(using: .utf8) else {
            status = nil
            problem = FileManager.default.isExecutableFile(atPath: Self.binary)
                ? "Bouncer isn't running."
                : "Bouncer isn't installed."
            return
        }
        do {
            status = try JSONDecoder().decode(Status.self, from: data)
            problem = nil
        } catch {
            status = nil
            problem = "Couldn't read Bouncer's status. Is the app older than the daemon?"
        }
    }

    func prioritize(job: Int) async { _ = await Self.run(["prioritize", String(job)]); await refresh() }
    func cancel(job: Int) async { _ = await Self.run(["cancel", String(job)]); await refresh() }

    func startDaemon() async {
        let uid = getuid()
        _ = await Self.exec("/bin/launchctl", ["kickstart", "-k", "gui/\(uid)/com.bouncer.daemon"])
        try? await Task.sleep(for: .seconds(1))
        await refresh()
    }

    struct Output: Sendable {
        let code: Int32
        let stdout: String
    }

    static func run(_ args: [String]) async -> Output {
        await exec(binary, args)
    }

    static func exec(_ path: String, _ args: [String]) async -> Output {
        await Task.detached {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: path)
            p.arguments = args
            let out = Pipe()
            p.standardOutput = out
            p.standardError = FileHandle.nullDevice
            do {
                try p.run()
            } catch {
                return Output(code: -1, stdout: "")
            }
            let data = out.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            return Output(code: p.terminationStatus, stdout: String(decoding: data, as: UTF8.self))
        }.value
    }
}
