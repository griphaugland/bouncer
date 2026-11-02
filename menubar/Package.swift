// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "BouncerBar",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "BouncerBar", path: "Sources/BouncerBar")
    ]
)
