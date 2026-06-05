package network.luuk.horizontv.discovery

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.Serializable
import okhttp3.OkHttpClient
import okhttp3.Request

@Serializable
private data class HealthBody(
    val status: String = "",
    val serverName: String? = null,
    val instanceId: String? = null,
    val version: String? = null,
)

private val healthJson = Json { ignoreUnknownKeys = true }

/**
 * GET [baseUrl]/health. Returns a [DiscoveredServer] when the server reports
 * `status:ok`, else null. Never throws — connection failures map to null so the
 * sweep can fire hundreds of these concurrently.
 */
suspend fun probeHealth(client: OkHttpClient, baseUrl: String, source: Source): DiscoveredServer? =
    withContext(Dispatchers.IO) {
        try {
            val req = Request.Builder().url("$baseUrl/health").get().build()
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return@withContext null
                val body = resp.body?.string().orEmpty()
                val parsed = healthJson.decodeFromString(HealthBody.serializer(), body)
                if (parsed.status != "ok") return@withContext null
                DiscoveredServer(
                    instanceId = parsed.instanceId,
                    name = parsed.serverName ?: baseUrl,
                    url = baseUrl,
                    source = source,
                    version = parsed.version,
                )
            }
        } catch (_: Throwable) {
            null
        }
    }
