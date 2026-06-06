package network.luuk.horizontv.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.serializer
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.logging.HttpLoggingInterceptor
import java.util.concurrent.TimeUnit

/**
 * Thin typed wrapper over OkHttp. Each call is a `suspend` that runs on
 * [Dispatchers.IO]. Failures surface as [ApiException] so callers can render
 * `error.code` / `error.message` without parsing bodies twice.
 */
class HorizonApi(
    private val baseUrl: String,
    val okHttp: OkHttpClient = defaultClient(),
) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    @Volatile
    private var token: String? = null
    @Volatile
    private var activeProfileId: String? = null

    fun setToken(value: String?) { token = value }
    fun setActiveProfile(id: String?) { activeProfileId = id }

    // ----- library -----
    suspend fun listMovies(): List<MediaItem> = get("/library/movies", serializer())
    suspend fun listShows(): List<ShowSummary> = get("/library/shows", serializer())
    suspend fun listCollections(): List<Collection> = get("/library/movies/collections", serializer())

    suspend fun getShow(id: String): ShowSummary = get("/library/shows/$id", serializer())
    suspend fun listEpisodes(showId: String, season: Int): List<MediaItem> =
        get("/library/shows/$showId/seasons/$season", serializer())

    // ----- progress -----
    suspend fun continueWatching(userId: String): List<ContinueWatchingItem> =
        get("/users/$userId/continue-watching", serializer())

    suspend fun getProgress(userId: String, mediaId: String): WatchProgress? =
        try { get("/users/$userId/progress/$mediaId", serializer<WatchProgress>()) }
        catch (e: ApiException) { if (e.status == 404) null else throw e }

    // ----- sessions -----
    suspend fun createSession(body: CreateSessionBody): SessionInfo =
        post("/sessions", body, serializer())
    suspend fun destroySession(id: String) = delete("/sessions/$id")

    // ----- auth -----
    suspend fun pairStart(): PairStartResult = postEmpty("/auth/pair/start", serializer())

    suspend fun pairPoll(code: String): PairPoll = withContext(Dispatchers.IO) {
        val payload = json.encodeToString(serializer(), PairPollBody(code))
        val req = Request.Builder().url(baseUrl + "/auth/pair/poll").post(payload.toRequestBody(jsonMedia))
        authHeaders(req)
        okHttp.newCall(req.build()).execute().use { resp ->
            val body = resp.body?.string().orEmpty()
            when {
                resp.code == 202 -> PairPoll.Pending
                resp.isSuccessful -> PairPoll.Authed(json.decodeFromString(AuthResult.serializer(), body))
                else -> {
                    val parsed = runCatching { json.decodeFromString(ErrorBody.serializer(), body) }.getOrNull()
                    throw ApiException(resp.code, parsed?.code, parsed?.error ?: "HTTP ${resp.code}")
                }
            }
        }
    }

    suspend fun login(name: String, password: String): AuthResult =
        post("/auth/login", LoginBody(name, password), serializer())

    suspend fun getGrant(): GrantResult = get("/auth/grant", serializer())

    // ----- generic helpers --------------------------------------------------

    private suspend fun <T> get(path: String, ser: KSerializer<T>): T =
        exec(Request.Builder().url(baseUrl + path).get(), ser)

    private suspend inline fun <reified Body, T> post(
        path: String,
        body: Body,
        ser: KSerializer<T>,
    ): T {
        val payload = json.encodeToString(serializer(), body)
        val req = Request.Builder()
            .url(baseUrl + path)
            .post(payload.toRequestBody(jsonMedia))
        return exec(req, ser)
    }

    private suspend fun delete(path: String) {
        val req = Request.Builder().url(baseUrl + path).delete()
        exec(req, serializer<Unit>())
    }

    private suspend fun <T> postEmpty(path: String, ser: KSerializer<T>): T =
        exec(Request.Builder().url(baseUrl + path).post(ByteArray(0).toRequestBody(jsonMedia)), ser)

    /** Apply auth headers to a request builder (bearer always when set; the
     *  active-profile selector only when one is chosen). */
    private fun authHeaders(req: Request.Builder) {
        token?.let { req.header("Authorization", "Bearer $it") }
        activeProfileId?.let { req.header("X-Horizon-Profile", it) }
    }

    private suspend fun <T> exec(req: Request.Builder, ser: KSerializer<T>): T =
        withContext(Dispatchers.IO) {
            authHeaders(req)
            okHttp.newCall(req.build()).execute().use { resp ->
                val body = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) {
                    val parsed = runCatching { json.decodeFromString(ErrorBody.serializer(), body) }.getOrNull()
                    if (resp.code == 401) throw Unauthorized(parsed?.code, parsed?.error ?: "Unauthorized")
                    throw ApiException(resp.code, parsed?.code, parsed?.error ?: "HTTP ${resp.code}")
                }
                if (ser.descriptor.serialName == "kotlin.Unit") {
                    @Suppress("UNCHECKED_CAST") return@withContext Unit as T
                }
                if (body.isEmpty()) throw ApiException(resp.code, "empty-body", "Empty response")
                json.decodeFromString(ser, body)
            }
        }

    companion object {
        fun defaultClient(): OkHttpClient {
            val logger = HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC }
            return OkHttpClient.Builder()
                .connectTimeout(5, TimeUnit.SECONDS)
                .readTimeout(60, TimeUnit.SECONDS)
                .writeTimeout(15, TimeUnit.SECONDS)
                .addInterceptor(logger)
                .build()
        }
    }
}

open class ApiException(
    val status: Int,
    val code: String?,
    override val message: String,
) : RuntimeException(message)

/** A 401 — the session token is missing/expired. Callers (AppState) drop the
 *  token and route back to AuthScreen rather than handling it per-screen. */
class Unauthorized(code: String?, message: String) : ApiException(401, code, message)

@kotlinx.serialization.Serializable
data class PairPollBody(val code: String)

sealed interface PairPoll {
    data object Pending : PairPoll
    data class Authed(val result: AuthResult) : PairPoll
}
