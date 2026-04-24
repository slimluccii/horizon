package network.luuk.horizontv.api

import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/** Lightweight wrapper around an OkHttp WebSocket. Sends periodic progress
 *  updates — the server's WS handler is idempotent and ignores messages it
 *  doesn't recognise, so we don't need any ack handling. */
class ProgressSocket(
    private val client: OkHttpClient,
    private val baseHttpUrl: String,   // e.g. http://host:port
) {
    private val json = Json { encodeDefaults = true }
    private var socket: WebSocket? = null

    fun connect(wsPath: String) {
        disconnect()
        // Server returns ws path like "/sessions/:id/ws" — swap http[s] for ws[s].
        val wsUrl = baseHttpUrl
            .replaceFirst("http://", "ws://")
            .replaceFirst("https://", "wss://") + wsPath
        val req = Request.Builder().url(wsUrl).build()
        socket = client.newWebSocket(req, object : WebSocketListener() {
            override fun onFailure(ws: WebSocket, t: Throwable, r: okhttp3.Response?) {
                // Transient — next report attempt will create a new socket.
                socket = null
            }
        })
    }

    fun reportProgress(positionMs: Int, durationMs: Int) {
        val msg = ProgressReportMessage(positionMs = positionMs, durationMs = durationMs)
        val text = json.encodeToString(ProgressReportMessage.serializer(), msg)
        socket?.send(text)
    }

    fun disconnect() {
        socket?.close(1000, "bye")
        socket = null
    }
}
