package network.luuk.horizontv.api

import org.junit.Assert.assertEquals
import org.junit.Test

class PlaybackAuthTest {
    @Test fun `stream requests carry the session bearer, the active profile and the reconnect token`() {
        assertEquals(
            mapOf("Authorization" to "Bearer tok", "X-Horizon-Profile" to "p1", "X-Reconnect-Token" to "rt"),
            playbackHeaders(token = "tok", profileId = "p1", reconnectToken = "rt"),
        )
    }

    @Test fun `leaves out what is not set`() {
        assertEquals(mapOf("X-Reconnect-Token" to "rt"), playbackHeaders(token = null, profileId = null, reconnectToken = "rt"))
    }
}
