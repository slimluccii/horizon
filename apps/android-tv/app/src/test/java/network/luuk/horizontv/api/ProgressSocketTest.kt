package network.luuk.horizontv.api

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProgressSocketTest {

    // ---- Pure backoff math -------------------------------------------------

    @Test fun `backoff is 2s 4s 8s 16s 32s for attempts 0 through 4`() {
        assertEquals(2_000L, ProgressSocket.backoffDelayMs(0))
        assertEquals(4_000L, ProgressSocket.backoffDelayMs(1))
        assertEquals(8_000L, ProgressSocket.backoffDelayMs(2))
        assertEquals(16_000L, ProgressSocket.backoffDelayMs(3))
        assertEquals(32_000L, ProgressSocket.backoffDelayMs(4))
    }

    @Test fun `backoff is clamped at the max delay and never overflows`() {
        assertEquals(ProgressSocket.MAX_DELAY_MS, ProgressSocket.backoffDelayMs(5))
        assertEquals(ProgressSocket.MAX_DELAY_MS, ProgressSocket.backoffDelayMs(40))
        assertEquals(ProgressSocket.MAX_DELAY_MS, ProgressSocket.backoffDelayMs(Int.MAX_VALUE))
    }

    @Test fun `backoff treats negative attempts as zero`() {
        assertEquals(2_000L, ProgressSocket.backoffDelayMs(-3))
    }

    // ---- Reconnect lifecycle ----------------------------------------------

    /** Records each scheduled reconnect and lets the test fire it manually. */
    private class FakeScheduler : ProgressSocket.Scheduler {
        val delays = mutableListOf<Long>()
        private val blocks = mutableListOf<() -> Unit>()
        var cancelledCount = 0

        override fun schedule(delayMs: Long, block: () -> Unit): ProgressSocket.Cancellable {
            delays += delayMs
            blocks += block
            val index = blocks.size - 1
            return ProgressSocket.Cancellable { cancelledCount++ }
        }

        /** Run the most recently scheduled block (simulates timer firing). */
        fun fireLast() {
            blocks.last().invoke()
        }
    }

    /** Counts opens and captures listeners so the test can drive onFailure. */
    private class FakeConnector : ProgressSocket.Connector {
        val openedUrls = mutableListOf<String>()
        val listeners = mutableListOf<WebSocketListener>()

        override fun open(wsUrl: String, listener: WebSocketListener): WebSocket {
            openedUrls += wsUrl
            listeners += listener
            return NoopWebSocket
        }

        /** Simulate the underlying socket failing. */
        fun failLast() {
            listeners.last().onFailure(NoopWebSocket, RuntimeException("boom"), null)
        }
    }

    private object NoopWebSocket : WebSocket {
        override fun cancel() {}
        override fun close(code: Int, reason: String?) = true
        override fun queueSize() = 0L
        override fun request() = Request.Builder().url("http://localhost/").build()
        override fun send(text: String) = true
        override fun send(bytes: okio.ByteString) = true
    }

    private fun newSocket(
        scheduler: FakeScheduler,
        connector: FakeConnector,
    ) = ProgressSocket(
        client = OkHttpClient(),
        baseHttpUrl = "http://host:7777",
        scheduler = scheduler,
        connector = connector,
    )

    @Test fun `connect maps http base to ws and opens once`() {
        val sched = FakeScheduler()
        val conn = FakeConnector()
        newSocket(sched, conn).connect("/sessions/abc/ws")

        assertEquals(1, conn.openedUrls.size)
        assertEquals("ws://host:7777/sessions/abc/ws", conn.openedUrls.single())
    }

    @Test fun `onFailure schedules a reconnect with the initial backoff`() {
        val sched = FakeScheduler()
        val conn = FakeConnector()
        newSocket(sched, conn).connect("/sessions/abc/ws")

        conn.failLast()

        assertEquals(listOf(ProgressSocket.INITIAL_DELAY_MS), sched.delays)
    }

    @Test fun `reconnect reuses the original ws path`() {
        val sched = FakeScheduler()
        val conn = FakeConnector()
        newSocket(sched, conn).connect("/sessions/abc/ws")

        conn.failLast()
        sched.fireLast() // timer fires -> reconnect

        assertEquals(2, conn.openedUrls.size)
        assertEquals("ws://host:7777/sessions/abc/ws", conn.openedUrls[1])
    }

    @Test fun `exponential backoff escalates across successive failures`() {
        val sched = FakeScheduler()
        val conn = FakeConnector()
        newSocket(sched, conn).connect("/s/ws")

        // attempt 0 -> 2s
        conn.failLast(); sched.fireLast()
        // attempt 1 -> 4s
        conn.failLast(); sched.fireLast()
        // attempt 2 -> 8s
        conn.failLast()

        assertEquals(listOf(2_000L, 4_000L, 8_000L), sched.delays)
    }

    @Test fun `reconnect stops after MAX_RETRIES attempts`() {
        val sched = FakeScheduler()
        val conn = FakeConnector()
        newSocket(sched, conn).connect("/s/ws")

        // Drive MAX_RETRIES failures, each followed by the scheduled reconnect.
        repeat(ProgressSocket.MAX_RETRIES) {
            conn.failLast()
            sched.fireLast()
        }
        // One more failure should NOT schedule another reconnect.
        conn.failLast()

        assertEquals(ProgressSocket.MAX_RETRIES, sched.delays.size)
    }

    @Test fun `disconnect cancels a pending reconnect`() {
        val sched = FakeScheduler()
        val conn = FakeConnector()
        val socket = newSocket(sched, conn)
        socket.connect("/s/ws")

        conn.failLast()       // schedules a reconnect
        socket.disconnect()   // must cancel the pending timer

        assertTrue("pending reconnect should be cancelled", sched.cancelledCount >= 1)
    }

    @Test fun `successful onOpen resets the backoff counter`() {
        val sched = FakeScheduler()
        val conn = FakeConnector()
        newSocket(sched, conn).connect("/s/ws")

        // Fail twice to advance the backoff to 8s.
        conn.failLast(); sched.fireLast()
        conn.failLast(); sched.fireLast()
        // Now the socket connects successfully.
        conn.listeners.last().onOpen(NoopWebSocket, dummyResponse())
        // A subsequent failure should restart backoff from the initial delay.
        conn.failLast()

        assertEquals(2_000L, sched.delays.last())
    }

    private fun dummyResponse(): Response =
        Response.Builder()
            .request(Request.Builder().url("http://localhost/").build())
            .protocol(okhttp3.Protocol.HTTP_1_1)
            .code(101)
            .message("Switching Protocols")
            .build()
}
