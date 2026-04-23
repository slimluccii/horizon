import SwiftUI
import Observation

/// Global state container: active user + cached users list. Mirrors
/// `useActiveUser()` in the web app.
///
/// Injected at the root via `.environment(HorizonClient.shared)` so any view
/// can read the active user without prop drilling. Persists the active ID to
/// UserDefaults so the choice survives relaunch.
@Observable
final class HorizonClient {
    static let shared = HorizonClient()

    let api = APIClient()

    /// The currently selected profile — nil until the user picks one.
    var activeUser: User?
    /// All users known to the server. Refreshed on launch + after mutations.
    var users: [User] = []
    /// Flips true once the initial bootstrap network call lands.
    var bootstrapped: Bool = false

    private let storageKey = "horizonActiveUserId"

    private init() {
        // Hydrate synchronously from UserDefaults so the first render can route
        // correctly. The authoritative user record loads from the server below.
        let savedId = UserDefaults.standard.string(forKey: storageKey)
        api.activeUserId = savedId
    }

    /// Call once at launch. Fetches the full user list and, if a saved active
    /// ID is valid, sets the active user. Side-effect: re-writes the header on
    /// APIClient so subsequent requests carry the correct identity.
    func bootstrap() async {
        do {
            let list = try await api.listUsers()
            await MainActor.run {
                self.users = list
                if let id = api.activeUserId, let u = list.first(where: { $0.id == id }) {
                    self.activeUser = u
                } else {
                    // Saved user no longer exists — clear the header.
                    self.activeUser = nil
                    self.api.activeUserId = nil
                    UserDefaults.standard.removeObject(forKey: self.storageKey)
                }
                self.bootstrapped = true
            }
        } catch {
            await MainActor.run { self.bootstrapped = true }
        }
    }

    func setActiveUser(_ user: User?) {
        activeUser = user
        api.activeUserId = user?.id
        if let id = user?.id {
            UserDefaults.standard.set(id, forKey: storageKey)
        } else {
            UserDefaults.standard.removeObject(forKey: storageKey)
        }
    }

    /// Refresh the cached users list after create/delete.
    func reloadUsers() async {
        if let list = try? await api.listUsers() {
            await MainActor.run { self.users = list }
        }
    }
}

// MARK: - TMDB image URLs

/// Convert a TMDB-relative image path (e.g. `/abc.jpg`) into a URL that hits
/// the Horizon server's image proxy. Returns nil when the path is empty so
/// call sites can render a placeholder.
enum TmdbImage {
    enum Size: String {
        case w92, w154, w185, w342, w500, w780, original
    }

    static func url(_ path: String?, size: Size = .w500) -> URL? {
        guard let path, !path.isEmpty else { return nil }
        let clean = path.hasPrefix("/") ? String(path.dropFirst()) : path
        return HorizonServer.baseURL.appendingPathComponent("metadata/image/\(size.rawValue)/\(clean)")
    }
}
