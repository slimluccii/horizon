package network.luuk.horizontv.api

import android.util.Log
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/** Lightweight wrapper around an OkHttp WebSocket. Sends periodic progress
 *  updates — the server's WS handler is idempotent and ignores messages it
 *  doesn't recognise, so we don't need any ack handling.
 *
 *  Resilience: when the underlying socket fails we log the error and schedule
 *  an automatic reconnect with exponential backoff (2s, 4s, 8s, 16s, 32s),
 *  capped at [MAX_RETRIES] attempts. Reconnect logic is fully encapsulated here
 *  and transparent to the UI layer — PlayerScreen never sees socket state. This
 *  is *not* a forever-reconnect: after MAX_RETRIES we give up and null the
 *  socket so the best-effort telemetry stream stops cleanly.
 *
 *  Scheduling and socket creation are injectable so the backoff behaviour can
 *  be unit-tested without a real Looper or network. */
class ProgressSocket(
    private val client: OkHttpClient,
    private val baseHttpUrl: String,   // e.g. http://host:port
    /** Schedules [block] to run after [delayMs]. Returns a handle that can
     *  cancel the pending run. Defaults to an Android main-thread Handler. */
    private val scheduler: Scheduler = HandlerScheduler(),
    /** Opens a WebSocket for [wsUrl] with [listener]. Defaults to OkHttp.
     *  Injectable so tests can simulate failures without a real network. */
    private val connector: Connector = OkHttpConnector(client),
) {
    /** Abstraction over delayed execution so tests can drive time deterministically. */
    interface Scheduler {
        fun schedule(delayMs: Long, block: () -> Unit): Cancellable
    }

    fun interface Cancellable {
        fun cancel()
    }

    /** Abstraction over opening a WebSocket so tests can avoid a real network. */
    fun interface Connector {
        fun open(wsUrl: String, listener: WebSocketListener): WebSocket?
    }

    private val json = Json { encodeDefaults = true }
    private var socket: WebSocket? = null

    // Reconnect state.
    private var wsPath: String? = null
    private var reconnectAttempt = 0
    private var pendingReconnect: Cancellable? = null

    fun connect(wsPath: String) {
        // A fresh caller-initiated connection resets backoff state.
        this.wsPath = wsPath
        reconnectAttempt = 0
        openSocket(wsPath)
    }

    private fun openSocket(wsPath: String) {
        cancelPendingReconnect()
        disconnectSocketOnly()
        // Server returns ws path like "/sessions/:id/ws" — swap http[s] for ws[s].
        val wsUrl = baseHttpUrl
            .replaceFirst("http://", "ws://")
            .replaceFirst("https://", "wss://") + wsPath
        socket = connector.open(wsUrl, object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: okhttp3.Response) {
                // Connection confirmed — clear any accumulated backoff.
                reconnectAttempt = 0
            }

            override fun onFailure(ws: WebSocket, t: Throwable, r: okhttp3.Response?) {
                Log.w(TAG, "WebSocket failure (attempt $reconnectAttempt): ${t.message}", t)
                socket = null
                scheduleReconnect()
            }
        })
    }

    private fun scheduleReconnect() {
        val path = wsPath ?: return
        if (reconnectAttempt >= MAX_RETRIES) {
            Log.w(TAG, "Giving up reconnect after $MAX_RETRIES attempts")
            return
        }
        val delay = backoffDelayMs(reconnectAttempt)
        reconnectAttempt++
        cancelPendingReconnect()
        pendingReconnect = scheduler.schedule(delay) { openSocket(path) }
    }

    fun reportProgress(positionMs: Int, durationMs: Int) {
        val msg = ProgressReportMessage(positionMs = positionMs, durationMs = durationMs)
        val text = json.encodeToString(ProgressReportMessage.serializer(), msg)
        socket?.send(text)
    }

    fun disconnect() {
        cancelPendingReconnect()
        wsPath = null
        reconnectAttempt = 0
        disconnectSocketOnly()
    }

    private fun disconnectSocketOnly() {
        socket?.close(1000, "bye")
        socket = null
    }

    private fun cancelPendingReconnect() {
        pendingReconnect?.cancel()
        pendingReconnect = null
    }

    companion object {
        const val INITIAL_DELAY_MS = 2_000L
        const val MAX_DELAY_MS = 32_000L
        const val MAX_RETRIES = 5

        private const val TAG = "ProgressSocket"

        /** Exponential backoff: 2s, 4s, 8s, 16s, 32s, capped at [MAX_DELAY_MS].
         *  Pure function — unit-tested directly. */
        fun backoffDelayMs(attempt: Int): Long {
            val safe = attempt.coerceAtLeast(0)
            // Guard against overflow on large attempts before clamping.
            if (safe >= 31) return MAX_DELAY_MS
            val raw = INITIAL_DELAY_MS shl safe
            return raw.coerceAtMost(MAX_DELAY_MS)
        }
    }
}

/** Default connector backed by OkHttp. */
private class OkHttpConnector(private val client: OkHttpClient) : ProgressSocket.Connector {
    override fun open(wsUrl: String, listener: WebSocketListener): WebSocket {
        val req = Request.Builder().url(wsUrl).build()
        return client.newWebSocket(req, listener)
    }
}

/** Default scheduler backed by the Android main-thread Handler. */
private class HandlerScheduler : ProgressSocket.Scheduler {
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())
    override fun schedule(delayMs: Long, block: () -> Unit): ProgressSocket.Cancellable {
        val runnable = Runnable { block() }
        handler.postDelayed(runnable, delayMs)
        return ProgressSocket.Cancellable { handler.removeCallbacks(runnable) }
    }
}
