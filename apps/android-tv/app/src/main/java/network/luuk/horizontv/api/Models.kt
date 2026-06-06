package network.luuk.horizontv.api

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

// ---------- users -----------------------------------------------------------

@Serializable
data class User(
    val id: String,
    val name: String,
    val avatar: String? = null,
    val preferences: Map<String, JsonElement> = emptyMap(),
    val createdAt: Long,
    val updatedAt: Long,
)


// ---------- media -----------------------------------------------------------

@Serializable
data class HdrFlags(
    val dv: Boolean = false,
    val hdr10: Boolean = false,
    val hdr10plus: Boolean = false,
    val dvProfile: Int? = null,
)

@Serializable
data class AudioTrack(
    val index: Int,
    val codec: String,
    val channels: Int,
    val language: String,
    val title: String,
    @SerialName("default") val isDefault: Boolean = false,
)

@Serializable
data class SubtitleTrack(
    val index: Int,
    val codec: String,
    val language: String,
    val forced: Boolean = false,
    val embeddable: Boolean = false,
)

@Serializable
data class ExternalIds(val tmdb: Int? = null, val tvdb: Int? = null, val imdb: String? = null)

@Serializable
data class LooseMetadata(
    val title: String? = null,
    val tagline: String? = null,
    val overview: String? = null,
    val releaseDate: String? = null,
    val firstAirDate: String? = null,
    val airDate: String? = null,
    val rating: Double? = null,
    val ratingCount: Int? = null,
    val runtimeMinutes: Int? = null,
    val genres: List<String>? = null,
    val posterPath: String? = null,
    val backdropPath: String? = null,
    val stillPath: String? = null,
    val network: String? = null,
    val status: String? = null,
    val tmdbId: Int? = null,
)

@Serializable
data class MediaItem(
    val id: String,
    val kind: String,
    val title: String,
    val parentId: String? = null,
    val sortYear: Int? = null,
    val season: Int? = null,
    val episode: Int? = null,
    val durationSec: Double? = null,
    val resolution: String? = null,
    val videoCodec: String? = null,
    val container: String? = null,
    val hdr: HdrFlags? = null,
    val audioTracks: List<AudioTrack>? = null,
    val subtitleTracks: List<SubtitleTrack>? = null,
    val externalIds: ExternalIds? = null,
    val metadata: LooseMetadata? = null,
)

@Serializable
data class SeasonSummary(val number: Int, val episodeCount: Int)

@Serializable
data class ShowSummary(
    val id: String,
    val title: String,
    val seasons: List<SeasonSummary>,
    val externalIds: ExternalIds? = null,
    val metadata: LooseMetadata? = null,
)

@Serializable
data class Collection(
    val id: String,
    val name: String,
    val movies: List<MediaItem>,
)

// ---------- progress --------------------------------------------------------

@Serializable
data class WatchProgress(
    val mediaId: String,
    val positionMs: Int,
    val durationMs: Int,
    val watched: Boolean,
    val updatedAt: Long,
)

@Serializable
data class ContinueWatchingItem(
    val mediaId: String,
    val kind: String,
    val positionMs: Int,
    val durationMs: Int,
    val percent: Int,
    val updatedAt: Long,
    val media: MediaItem,
    val show: MediaItem? = null,
)

// ---------- sessions --------------------------------------------------------

@Serializable
data class Capabilities(
    val videoCodecs: List<String>,
    val audioCodecs: List<String>,
    val hdr: List<String>,
    val maxBitrate: Int,
    val container: List<String>,
)

@Serializable
data class CreateSessionBody(
    val mediaId: String,
    val capabilities: Capabilities,
    val audioTrackIndex: Int = 0,
    val subtitleTrackIndex: Int? = null,
    val userId: String? = null,
    val startPositionMs: Int? = null,
)

@Serializable
data class QualityProfile(
    val name: String? = null,
    val videoBitrate: Int,
    val audioBitrate: Int,
    val width: Int? = null,
    val height: Int? = null,
)

@Serializable
data class SessionInfo(
    val sessionId: String,
    val method: String,
    val streamUrl: String,
    val wsUrl: String,
    val profiles: List<QualityProfile>,
    val selectedAudioTrack: Int,
    val selectedSubtitleTrack: Int? = null,
)

// ---------- progress WS -----------------------------------------------------

@Serializable
data class ProgressReportMessage(
    val type: String = "progress",
    val positionMs: Int,
    val durationMs: Int,
)

// ---------- errors ----------------------------------------------------------

@Serializable
data class ErrorBody(val error: String? = null, val code: String? = null)

// ---------- auth ------------------------------------------------------------

@Serializable
data class Profile(val id: String, val name: String, val avatar: String? = null)

@Serializable
data class PairStartResult(val code: String, val expiresAt: Long)

/** Response of /auth/pair/poll (when approved) and /auth/login. `profiles` is
 *  present on the pairing poll (granted set); login returns it empty and the
 *  caller follows up with /auth/grant. */
@Serializable
data class AuthResult(
    val token: String,
    val user: User,
    val grant: List<String> = emptyList(),
    val profiles: List<Profile> = emptyList(),
)

@Serializable
data class GrantResult(val profiles: List<Profile> = emptyList())

@Serializable
data class LoginBody(val name: String, val password: String)
