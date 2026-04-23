// swift-tools-version:5.9
import PackageDescription

/// Horizon native macOS client. Open this Package.swift in Xcode 15+ —
/// `xed Package.swift` or double-click — and Xcode generates the project
/// automatically. Build and run from there. No .xcodeproj checked in.
///
/// Target: macOS 14. Uses SwiftUI + Observation framework.
let package = Package(
    name: "Horizon",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Horizon", targets: ["Horizon"])
    ],
    targets: [
        .executableTarget(
            name: "Horizon",
            path: "Sources/Horizon",
            resources: [
                .process("Resources")
            ]
        )
    ]
)
