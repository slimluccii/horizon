import SwiftUI

/// Top-level router. Three guarded states mirror the web Guard:
///  1. No users on the server → `SetupView`
///  2. Users exist but no active selection → `ProfilePickerView`
///  3. Active user selected → `LibraryView`
///
/// Navigation inside the library (show detail, player) uses a `NavigationStack`
/// rooted at the library view.
struct ContentView: View {
    @State private var client = HorizonClient.shared
    @State private var path = NavigationPath()

    var body: some View {
        Group {
            if !client.bootstrapped {
                VStack(spacing: 16) {
                    ProgressView()
                        .progressViewStyle(.circular)
                        .tint(.horizonAccent)
                    Text("Connecting to horizon.local…")
                        .font(.horizon(size: 12, weight: .bold))
                        .tracking(2)
                        .foregroundStyle(.horizonMuted)
                        .textCase(.uppercase)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.horizonBgDeep)
            } else if client.users.isEmpty {
                SetupView()
            } else if client.activeUser == nil {
                ProfilePickerView()
            } else {
                NavigationStack(path: $path) {
                    LibraryView()
                        .navigationDestination(for: Route.self) { route in
                            switch route {
                            case .show(let id):
                                ShowDetailView(showId: id)
                            case .play(let id):
                                PlayerView(mediaId: id)
                            }
                        }
                }
            }
        }
        .environment(client)
        .task {
            if !client.bootstrapped {
                await client.bootstrap()
            }
        }
    }
}

/// Typed navigation targets. Works with `NavigationLink(value:)` and
/// `navigationDestination(for:)`.
enum Route: Hashable {
    case show(String)
    case play(String)
}
