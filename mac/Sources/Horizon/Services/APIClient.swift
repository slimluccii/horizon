import Foundation

/// Base URL for the Horizon server. Overridable at launch via
/// `HORIZON_SERVER_URL` env var so devs can point at a staging host.
enum HorizonServer {
    static let defaultUrl = "http://localhost:7777"

    static var baseURL: URL {
        let raw = ProcessInfo.processInfo.environment["HORIZON_SERVER_URL"] ?? defaultUrl
        return URL(string: raw)!
    }
}

struct APIError: Error, LocalizedError {
    let status: Int
    let code: String?
    let message: String?
    var errorDescription: String? {
        if let m = message { return m }
        return "HTTP \(status)"
    }
}

private struct ErrorBody: Decodable {
    let error: String?
    let code: String?
}

/// Horizon HTTP client. Single instance owned by `HorizonClient`. Automatically
/// attaches `X-Horizon-User` to every request when `activeUserId` is set, which
/// matches the web SDK's behaviour.
@Observable
final class APIClient {
    var activeUserId: String?

    private let base: URL
    private let session: URLSession

    init(baseURL: URL = HorizonServer.baseURL) {
        self.base = baseURL
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = true
        self.session = URLSession(configuration: config)
    }

    // MARK: Request

    func request<Out: Decodable>(
        _ path: String,
        method: String = "GET",
        body: Encodable? = nil
    ) async throws -> Out {
        var req = URLRequest(url: base.appendingPathComponent(path))
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let id = activeUserId {
            req.setValue(id, forHTTPHeaderField: "X-Horizon-User")
        }
        if let body = body {
            req.httpBody = try JSONEncoder().encode(AnyEncodable(body))
        }

        let (data, response) = try await session.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? -1

        guard (200..<300).contains(status) else {
            let err = (try? JSONDecoder().decode(ErrorBody.self, from: data))
            throw APIError(status: status, code: err?.code, message: err?.error)
        }

        // Handle 204 / empty payloads gracefully when the caller asked for `Empty`.
        if Out.self == Empty.self {
            return Empty() as! Out
        }
        return try JSONDecoder().decode(Out.self, from: data)
    }

    // MARK: Convenience

    func get<Out: Decodable>(_ path: String) async throws -> Out {
        try await request(path, method: "GET", body: nil)
    }

    @discardableResult
    func delete(_ path: String) async throws -> Empty {
        try await request(path, method: "DELETE", body: nil)
    }

    // MARK: - Users

    func listUsers() async throws -> [User] {
        try await get("/users")
    }
    func getUser(_ id: String) async throws -> User {
        try await get("/users/\(id)")
    }
    func createUser(name: String, avatar: String?) async throws -> User {
        try await request("/users", method: "POST", body: CreateUserBody(name: name, avatar: avatar))
    }
    func deleteUser(_ id: String) async throws {
        _ = try await delete("/users/\(id)")
    }

    // MARK: - Library

    func listMovies() async throws -> [MediaItem] {
        try await get("/library/movies")
    }
    func listShows() async throws -> [ShowSummary] {
        try await get("/library/shows")
    }
    func getShow(_ id: String) async throws -> ShowSummary {
        try await get("/library/shows/\(id)")
    }
    func listEpisodes(showId: String, season: Int) async throws -> [MediaItem] {
        try await get("/library/shows/\(showId)/seasons/\(season)")
    }
    func listCollections() async throws -> [Collection] {
        try await get("/library/movies/collections")
    }

    // MARK: - Progress

    func continueWatching(userId: String) async throws -> [ContinueWatchingItem] {
        try await get("/users/\(userId)/continue-watching")
    }
    func getProgress(userId: String, mediaId: String) async throws -> WatchProgress? {
        do {
            return try await get("/users/\(userId)/progress/\(mediaId)")
        } catch let e as APIError where e.code == "progress-not-found" {
            return nil
        }
    }

    // MARK: - Sessions

    func createSession(
        mediaId: String,
        startPositionMs: Int?,
        userId: String?
    ) async throws -> SessionInfo {
        let body = CreateSessionBody(
            mediaId: mediaId,
            capabilities: .init(
                videoCodecs: ["h264"],
                audioCodecs: ["aac"],
                hdr: [],
                maxBitrate: 0,
                container: ["hls"]
            ),
            audioTrackIndex: 0,
            subtitleTrackIndex: nil,
            userId: userId,
            startPositionMs: startPositionMs
        )
        return try await request("/sessions", method: "POST", body: body)
    }

    func destroySession(_ id: String) async throws {
        _ = try await delete("/sessions/\(id)")
    }
}

struct Empty: Codable {}

/// Type-erased Encodable wrapper so the generic request helper can take any
/// Encodable body without requiring each caller to spell out the type param.
struct AnyEncodable: Encodable {
    let wrapped: Encodable
    init(_ e: Encodable) { self.wrapped = e }
    func encode(to encoder: Encoder) throws { try wrapped.encode(to: encoder) }
}
