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
    private var activeUserId: String? = null

    fun setActiveUser(id: String?) {
        activeUserId = id
    }

    // ----- users -----
    suspend fun listUsers(): List<User> = get("/users", serializer())
    suspend fun createUser(body: CreateUserBody): User = post("/users", body, serializer())
    suspend fun deleteUser(id: String): Unit = delete("/users/$id")

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

    private suspend fun <T> exec(req: Request.Builder, ser: KSerializer<T>): T =
        withContext(Dispatchers.IO) {
            val userId = activeUserId
            if (userId != null) req.header("X-Horizon-User", userId)
            okHttp.newCall(req.build()).execute().use { resp ->
                val body = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) {
                    val parsed = runCatching { json.decodeFromString(ErrorBody.serializer(), body) }.getOrNull()
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

class ApiException(
    val status: Int,
    val code: String?,
    override val message: String,
) : RuntimeException(message)
