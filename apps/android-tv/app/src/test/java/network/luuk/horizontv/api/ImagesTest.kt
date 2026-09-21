package network.luuk.horizontv.api

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ImagesTest {
    @Test fun `poster url points at the image proxy of the connected server`() {
        assertEquals(
            "http://nas:7777/api/metadata/image/w342/abc.jpg",
            posterUrl("http://nas:7777", "/abc.jpg"),
        )
    }

    @Test fun `no url without a path or without a server`() {
        assertNull(posterUrl("http://nas:7777", null))
        assertNull(posterUrl("http://nas:7777", ""))
        assertNull(posterUrl(null, "/abc.jpg"))
    }

    @Test fun `image requests carry the session, because the proxy only serves someone who is logged in`() {
        val server = MockWebServer(); server.enqueue(MockResponse().setBody("img")); server.start()
        val client = OkHttpClient.Builder()
            .addInterceptor(SessionHeaderInterceptor { mapOf("Authorization" to "Bearer tok", "X-Horizon-Profile" to "kid") })
            .build()
        client.newCall(Request.Builder().url(server.url("/api/metadata/image/w342/abc.jpg")).build()).execute().close()
        val req = server.takeRequest()
        assertEquals("Bearer tok", req.getHeader("Authorization"))
        assertEquals("kid", req.getHeader("X-Horizon-Profile"))
        server.shutdown()
    }
}
