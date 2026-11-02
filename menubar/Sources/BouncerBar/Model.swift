import Foundation

// Mirrors `StatusSnapshot` in src/protocol.ts (only the fields the menu bar shows).

struct Status: Decodable, Sendable {
    let load: Load
    let pressureLevel: Int
    let freePercent: Int
    let swapUsedMb: Int
    let swapTotalMb: Int
    let diskFreeGb: Int
    let maxConcurrent: Int
    let slots: [Slot]
    let running: [Job]
    let queued: [Job]
    let external: [External]
    let sessions: [Session]
    let advice: [String]
    let jetsamSinceStart: Int
}

enum Load: String, Decodable, Sendable {
    case green, yellow, red

    var title: String {
        switch self {
        case .green: "Clear"
        case .yellow: "Tight"
        case .red: "Holding the door"
        }
    }

    var explanation: String {
        switch self {
        case .green: "Builds start as soon as their slot is free."
        case .yellow: "Memory is getting low. One heavy job at a time."
        case .red: "Memory is critical. Nothing new starts; normal jobs are stopped, newest first."
        }
    }
}

struct Slot: Decodable, Sendable, Identifiable {
    let name: String
    let capacity: Int
    let used: Int
    var id: String { name }
}

struct Job: Decodable, Sendable, Identifiable {
    let id: Int
    let slot: String
    let session: String
    let cmd: String
    let cwd: String
    let priority: String
    let state: String
    let waitReason: String?
    let position: Int?
    let elapsedMs: Double
    let rssMb: Int
}

struct External: Decodable, Sendable, Identifiable {
    let pid: Int
    let slot: String
    let command: String
    let rssMb: Int
    let elapsedSec: Double
    var id: Int { pid }

    /// `/opt/homebrew/Cellar/dotnet/10.0.400/libexec/dotnet test x` → `dotnet test x`
    var shortCommand: String {
        let parts = command.split(separator: " ", omittingEmptySubsequences: true)
        guard let exe = parts.first else { return command }
        return ([String(exe.split(separator: "/").last ?? exe)] + parts.dropFirst().map(String.init)).joined(separator: " ")
    }
}

struct Session: Decodable, Sendable, Identifiable {
    let pid: Int
    let kind: String
    let cwd: String?
    let rssMb: Int
    let elapsedSec: Double
    let idleSec: Double
    var id: Int { pid }
}

func formatDuration(seconds: Double) -> String {
    let s = Int(seconds.rounded())
    if s < 60 { return "\(s)s" }
    let m = s / 60
    if m < 60 { return "\(m)m" }
    let h = m / 60
    if h < 24 { return "\(h)h \(m % 60)m" }
    return "\(h / 24)d \(h % 24)h"
}

func formatMb(_ mb: Int) -> String {
    mb >= 1024 ? String(format: "%.1f GB", Double(mb) / 1024) : "\(mb) MB"
}

func homeRelative(_ path: String?) -> String {
    guard let path else { return "" }
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    return path.hasPrefix(home) ? "~" + path.dropFirst(home.count) : path
}
