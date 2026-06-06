package network.luuk.horizontv.discovery

import kotlinx.coroutines.runBlocking
import network.luuk.horizontv.api.Profile
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AuthResolverTest {
    @Test fun `no saved token needs auth`() = runBlocking {
        val d = resolveAuth(savedToken = null, fetchGrant = { error("not called") })
        assertTrue(d is AuthDecision.NeedAuth)
    }

    @Test fun `valid token yields the granted profiles`() = runBlocking {
        val profiles = listOf(Profile("u1", "A"), Profile("u2", "B"))
        val d = resolveAuth(savedToken = "t", fetchGrant = { profiles })
        assertEquals(AuthDecision.Authed("t", profiles), d)
    }

    @Test fun `token rejected (fetchGrant returns null) needs auth`() = runBlocking {
        val d = resolveAuth(savedToken = "t", fetchGrant = { null })
        assertTrue(d is AuthDecision.NeedAuth)
    }
}
