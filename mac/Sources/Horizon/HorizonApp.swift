import SwiftUI

/// Entry point. Boots the SwiftUI lifecycle, registers the embedded Nunito
/// font family before any view mounts, and hands everything else to
/// `ContentView` which owns the router + guard.
@main
struct HorizonApp: App {
    init() {
        FontLoader.registerEmbeddedFonts()
    }

    var body: some Scene {
        WindowGroup("Horizon") {
            ContentView()
                .frame(minWidth: 1280, minHeight: 720)
                .background(Color.horizonBg)
                .preferredColorScheme(.dark)
        }
        .windowStyle(.hiddenTitleBar)
        .windowResizability(.contentMinSize)
    }
}
