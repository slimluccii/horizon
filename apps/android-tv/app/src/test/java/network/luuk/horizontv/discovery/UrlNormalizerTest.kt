package network.luuk.horizontv.discovery

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class UrlNormalizerTest {
    @Test fun `bare host gets scheme and default port`() {
        assertEquals("http://192.168.1.5:7777", normalizeServerUrl("192.168.1.5"))
    }
    @Test fun `host with port keeps port`() {
        assertEquals("http://192.168.1.5:8000", normalizeServerUrl("192.168.1.5:8000"))
    }
    @Test fun `scheme preserved, trailing slash trimmed`() {
        assertEquals("http://den.local:7777", normalizeServerUrl("http://den.local:7777/"))
    }
    @Test fun `blank is rejected`() {
        assertNull(normalizeServerUrl("   "))
    }
}
