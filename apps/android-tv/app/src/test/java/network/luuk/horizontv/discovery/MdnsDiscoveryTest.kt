package network.luuk.horizontv.discovery

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MdnsDiscoveryTest {
    private fun txt(vararg pairs: Pair<String, String>): Map<String, ByteArray> =
        pairs.associate { (k, v) -> k to v.toByteArray(Charsets.UTF_8) }

    @Test fun `maps a fully-populated service`() {
        val server = toDiscoveredServer(
            host = "192.168.1.10",
            port = 7777,
            serviceName = "fallback-name",
            attributes = txt("id" to "abc123", "name" to "Den", "v" to "0.1.0"),
        )
        assertEquals(
            DiscoveredServer(
                instanceId = "abc123",
                name = "Den",
                url = "http://192.168.1.10:7777",
                source = Source.Mdns,
                version = "0.1.0",
            ),
            server,
        )
    }

    @Test fun `null host drops the result`() {
        val server = toDiscoveredServer(
            host = null,
            port = 7777,
            serviceName = "Den",
            attributes = txt("id" to "abc123"),
        )
        assertNull(server)
    }

    @Test fun `missing name TXT falls back to serviceName`() {
        val server = toDiscoveredServer(
            host = "192.168.1.10",
            port = 7777,
            serviceName = "horizon-den",
            attributes = emptyMap(),
        )
        assertEquals("horizon-den", server?.name)
    }

    @Test fun `missing id and version TXT records yield nulls`() {
        val server = toDiscoveredServer(
            host = "192.168.1.10",
            port = 7777,
            serviceName = "horizon-den",
            attributes = emptyMap(),
        )
        assertNull(server?.instanceId)
        assertNull(server?.version)
    }

    @Test fun `assembles http url from host and port`() {
        val server = toDiscoveredServer(
            host = "10.0.0.5",
            port = 8080,
            serviceName = "x",
            attributes = emptyMap(),
        )
        assertEquals("http://10.0.0.5:8080", server?.url)
    }
}
