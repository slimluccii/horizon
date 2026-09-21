package network.luuk.horizontv.api

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Test

/** The server mounts every route under /api; the base url the user enters is only host and port. */
class HorizonApiPathTest {
    private fun withServer(vararg bodies: String, block: suspend (HorizonApi, MockWebServer) -> Unit) = runBlocking {
        val server = MockWebServer()
        bodies.forEach { server.enqueue(MockResponse().setBody(it)) }
        server.start()
        try { block(HorizonApi(baseUrl = server.url("/").toString().trimEnd('/')), server) } finally { server.shutdown() }
    }

    @Test fun `library calls go to the api prefix`() = withServer("[]", "[]") { api, server ->
        api.listMovies()
        assertEquals("/api/library/movies", server.takeRequest().path)
        api.listShows()
        assertEquals("/api/library/shows", server.takeRequest().path)
    }

    @Test fun `auth calls go to the api prefix`() = withServer { api, server ->
        server.enqueue(MockResponse().setResponseCode(202).setBody("""{"status":"pending"}"""))
        api.pairPoll("ABCD-1234")
        assertEquals("/api/auth/pair/poll", server.takeRequest().path)
    }

    @Test fun `session calls go to the api prefix`() = withServer(
        """{"sessionId":"s1","method":"transcode","streamUrl":"/api/sessions/s1/stream.m3u8","wsUrl":"/api/sessions/s1/ws","profiles":[],"selectedAudioTrack":0}""",
        "{}",
    ) { api, server ->
        api.createSession(CreateSessionBody(mediaId = "m1", capabilities = Capabilities(emptyList(), emptyList(), emptyList(), 0, emptyList())))
        val create = server.takeRequest()
        assertEquals("/api/sessions", create.path)
        // The server validates the body strictly: an absent field is fine, a null one is rejected.
        assertEquals(false, create.body.readUtf8().contains("null"))
        api.destroySession("s1", "rt")
        val delete = server.takeRequest()
        assertEquals("/api/sessions/s1", delete.path)
        assertEquals("rt", delete.getHeader("X-Reconnect-Token"))
    }
}
