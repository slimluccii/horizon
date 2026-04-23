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
            ],
            linkerSettings: [
                // Embed Info.plist directly into the binary via a Mach-O
                // section. SPM executables have no bundle plist otherwise,
                // which means CFBundleIdentifier is missing AND AVFoundation
                // applies the strictest ATS policy (blocking http://127.0.0.1).
                // `_main` tool, no NSBundle, so `__info_plist` is the only
                // path that makes Launch Services + ATS see our keys.
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "Info.plist"
                ])
            ]
        )
    ]
)
