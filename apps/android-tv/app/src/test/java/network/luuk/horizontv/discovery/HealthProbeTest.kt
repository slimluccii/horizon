package network.luuk.horizontv.discovery

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HealthProbeTest {
    @Test fun `parses identity from a healthy server`() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody(
            """{"status":"ok","serverName":"Den","instanceId":"id-1","version":"0.1.0"}"""
        ))
        server.start()
        val url = server.url("/").toString().trimEnd('/')
        val result = probeHealth(OkHttpClient(), url, Source.Sweep)
        assertEquals("Den", result?.name)
        assertEquals("id-1", result?.instanceId)
        server.shutdown()
    }

    @Test fun `returns null on non-200`() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(404))
        server.start()
        val url = server.url("/").toString().trimEnd('/')
        assertNull(probeHealth(OkHttpClient(), url, Source.Sweep))
        server.shutdown()
    }
}
