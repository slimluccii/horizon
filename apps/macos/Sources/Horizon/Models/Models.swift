import Foundation

// MARK: - User

struct User: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let avatar: String?
    let preferences: [String: JSONValue]
    let createdAt: Int64
    let updatedAt: Int64
}

struct CreateUserBody: Encodable {
    let name: String
    let avatar: String?
}

// MARK: - Media

struct HdrFlags: Codable, Hashable {
    let dv: Bool
    let hdr10: Bool
    let hdr10plus: Bool
    let dvProfile: Int?
}

struct AudioTrack: Codable, Hashable {
    let index: Int
    let codec: String
    let channels: Int
    let language: String
    let title: String
    let `default`: Bool
}

struct SubtitleTrack: Codable, Hashable {
    let index: Int
    let codec: String
    let language: String
    let forced: Bool
    let embeddable: Bool
}

struct ExternalIds: Codable, Hashable {
    let tmdb: Int?
    let tvdb: Int?
    let imdb: String?
}

struct MovieMetadata: Codable, Hashable {
    let tmdbId: Int?
    let title: String?
    let tagline: String?
    let overview: String?
    let releaseDate: String?
    let runtimeMinutes: Int?
    let rating: Double?
    let ratingCount: Int?
    let genres: [String]?
    let posterPath: String?
    let backdropPath: String?
}

struct EpisodeMetadata: Codable, Hashable {
    let tmdbId: Int?
    let title: String?
    let overview: String?
    let airDate: String?
    let rating: Double?
    let runtimeMinutes: Int?
    let stillPath: String?
}

struct ShowMetadataInfo: Codable, Hashable {
    let tmdbId: Int?
    let title: String?
    let tagline: String?
    let overview: String?
    let firstAirDate: String?
    let status: String?
    let rating: Double?
    let ratingCount: Int?
    let genres: [String]?
    let posterPath: String?
    let backdropPath: String?
    let network: String?
}

/// Union metadata: server returns MovieMetadata for movies, EpisodeMetadata for
/// episodes. We decode a permissive superset to avoid juggling a kind tag.
struct LooseMetadata: Codable, Hashable {
    let title: String?
    let tagline: String?
    let overview: String?
    let releaseDate: String?
    let firstAirDate: String?
    let airDate: String?
    let rating: Double?
    let ratingCount: Int?
    let runtimeMinutes: Int?
    let genres: [String]?
    let posterPath: String?
    let backdropPath: String?
    let stillPath: String?
    let network: String?
    let status: String?
    let tmdbId: Int?
}

/// Matches the unified `media_items` row the server returns. Most fields are
/// optional because the server uses the same shape for movies (file-backed),
/// shows (container, no file) and episodes (file-backed with parent link).
/// Clients inspect `kind` to decide which fields to read.
struct MediaItem: Codable, Identifiable, Hashable {
    let id: String
    let kind: String                 // "movie" | "show" | "episode"
    let title: String
    let parentId: String?
    let sortYear: Int?
    let season: Int?
    let episode: Int?
    let durationSec: Double?
    let resolution: String?
    let videoCodec: String?
    let container: String?
    let hdr: HdrFlags?
    let audioTracks: [AudioTrack]?
    let subtitleTracks: [SubtitleTrack]?
    let externalIds: ExternalIds?
    let metadata: LooseMetadata?

    // Convenience — view code reads these; keeps call sites clean.
    var year: Int? { sortYear }
    var duration: Double { durationSec ?? 0 }
    var hasDolbyVision: Bool { hdr?.dv ?? false }
}

struct SeasonSummary: Codable, Hashable {
    let number: Int
    let episodeCount: Int
}

struct ShowSummary: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    let seasons: [SeasonSummary]
    let externalIds: ExternalIds?
    let metadata: ShowMetadataInfo?
}

struct Collection: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let movies: [MediaItem]
}

// MARK: - Progress

struct WatchProgress: Codable, Hashable {
    let mediaId: String
    let positionMs: Int
    let durationMs: Int
    let watched: Bool
    let updatedAt: Int64
}

struct ContinueWatchingItem: Codable, Identifiable, Hashable {
    let mediaId: String
    let kind: String   // "movie" | "episode"
    let positionMs: Int
    let durationMs: Int
    let percent: Int
    let updatedAt: Int64
    let media: MediaItem
    let show: MediaItem?

    var id: String { mediaId }
}

// MARK: - Session

struct SessionInfo: Codable {
    let sessionId: String
    let method: String
    let streamUrl: String
    let wsUrl: String
    let profiles: [QualityProfile]
    let selectedAudioTrack: Int
    let selectedSubtitleTrack: Int?
}

struct QualityProfile: Codable, Hashable {
    let name: String?
    let videoBitrate: Int
    let audioBitrate: Int
    let width: Int?
    let height: Int?
}

struct CreateSessionBody: Encodable {
    struct Capabilities: Encodable {
        let videoCodecs: [String]
        let audioCodecs: [String]
        let hdr: [String]
        let maxBitrate: Int
        let container: [String]
    }
    let mediaId: String
    let capabilities: Capabilities
    let audioTrackIndex: Int
    let subtitleTrackIndex: Int?
    let userId: String?
    let startPositionMs: Int?
}

// MARK: - Generic JSON helper

/// Decodes arbitrary JSON into a Swift enum. Used for `User.preferences` which
/// is an open-schema bag.
enum JSONValue: Codable, Hashable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let v = try? c.decode(Bool.self)   { self = .bool(v); return }
        if let v = try? c.decode(Double.self) { self = .number(v); return }
        if let v = try? c.decode(String.self) { self = .string(v); return }
        if let v = try? c.decode([String: JSONValue].self) { self = .object(v); return }
        if let v = try? c.decode([JSONValue].self)         { self = .array(v); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "unsupported JSON scalar")
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v):   try c.encode(v)
        case .object(let v): try c.encode(v)
        case .array(let v):  try c.encode(v)
        case .null:          try c.encodeNil()
        }
    }
}
