package network.luuk.horizontv.api

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HorizonApiAuthTest {
    private fun api(server: MockWebServer): HorizonApi =
        HorizonApi(baseUrl = server.url("/").toString().trimEnd('/'))

    @Test fun `sends Bearer token and no X-Horizon-User`() = runBlocking {
        val server = MockWebServer(); server.enqueue(MockResponse().setBody("[]")); server.start()
        val a = api(server); a.setToken("tok-1")
        a.listMovies()
        val req = server.takeRequest()
        assertEquals("Bearer tok-1", req.getHeader("Authorization"))
        assertNull(req.getHeader("X-Horizon-User"))
        server.shutdown()
    }

    @Test fun `sends X-Horizon-Profile only when an active profile is set`() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("[]"))
        server.enqueue(MockResponse().setBody("[]"))
        server.start()
        val a = api(server); a.setToken("t")
        a.listMovies()
        assertNull(server.takeRequest().getHeader("X-Horizon-Profile"))
        a.setActiveProfile("p1")
        a.listMovies()
        assertEquals("p1", server.takeRequest().getHeader("X-Horizon-Profile"))
        server.shutdown()
    }

    @Test fun `maps 401 to Unauthorized`() = runBlocking {
        val server = MockWebServer(); server.enqueue(MockResponse().setResponseCode(401).setBody("""{"code":"unauthorized"}""")); server.start()
        val a = api(server); a.setToken("t")
        var threw = false
        try { a.listMovies() } catch (e: Unauthorized) { threw = true }
        assertTrue(threw)
        server.shutdown()
    }

    @Test fun `pairPoll returns Pending on 202 and Authed on 200`() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(202).setBody("""{"status":"pending"}"""))
        server.enqueue(MockResponse().setBody("""{"token":"tk","user":{"id":"u1","name":"A","createdAt":0,"updatedAt":0},"grant":["u1"],"profiles":[{"id":"u1","name":"A"}]}"""))
        server.start()
        val a = api(server)
        assertTrue(a.pairPoll("ABCD-1234") is PairPoll.Pending)
        val r = a.pairPoll("ABCD-1234")
        assertTrue(r is PairPoll.Authed && r.result.token == "tk")
        server.shutdown()
    }

    @Test fun `a profile says whether it has a pin, and has none when the server does not say`() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("""{"profiles":[{"id":"u1","name":"A"},{"id":"kid","name":"Kid","hasPin":true}]}"""))
        server.start()
        val a = api(server); a.setToken("t")
        assertEquals(listOf(false, true), a.getGrant().profiles.map { it.hasPin })
        server.shutdown()
    }

    @Test fun `unlockProfile posts the pin without naming an active profile`() = runBlocking {
        val server = MockWebServer(); server.enqueue(MockResponse().setBody("""{"ok":true}""")); server.start()
        val a = api(server); a.setToken("t"); a.setActiveProfile("kid")
        assertEquals(PinResult.Unlocked, a.unlockProfile("kid", "1234"))
        val req = server.takeRequest()
        assertEquals("/api/auth/profile-unlock", req.path)
        assertEquals("""{"profileId":"kid","pin":"1234"}""", req.body.readUtf8())
        assertEquals("Bearer t", req.getHeader("Authorization"))
        assertNull(req.getHeader("X-Horizon-Profile"))
        server.shutdown()
    }

    @Test fun `a wrong pin is an answer, not a lost session`() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"code":"invalid-pin"}"""))
        server.enqueue(MockResponse().setResponseCode(429).setBody("""{"code":"pin-locked"}"""))
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"code":"unauthorized"}"""))
        server.start()
        val a = api(server); a.setToken("t")
        assertEquals(PinResult.Wrong, a.unlockProfile("kid", "0000"))
        assertEquals(PinResult.TooManyTries, a.unlockProfile("kid", "0000"))
        var threw = false
        try { a.unlockProfile("kid", "0000") } catch (e: Unauthorized) { threw = true }
        assertTrue(threw)
        server.shutdown()
    }
}
