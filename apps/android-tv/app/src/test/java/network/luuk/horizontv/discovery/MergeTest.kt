package network.luuk.horizontv.discovery

import org.junit.Assert.assertEquals
import org.junit.Test

class MergeTest {
    private fun mdns(id: String, name: String, url: String) =
        DiscoveredServer(id, name, url, Source.Mdns, "0.1.0")
    private fun sweep(id: String?, url: String) =
        DiscoveredServer(id, url, url, Source.Sweep, null)

    @Test fun `mdns entry wins over sweep with same instanceId`() {
        val merged = mergeDiscovered(
            listOf(mdns("a", "Den", "http://1.1.1.1:7777")),
            listOf(sweep("a", "http://1.1.1.1:7777")),
        )
        assertEquals(1, merged.size)
        assertEquals("Den", merged[0].name)
        assertEquals(Source.Mdns, merged[0].source)
    }

    @Test fun `sweep-only id is kept`() {
        val merged = mergeDiscovered(
            listOf(mdns("a", "Den", "http://1.1.1.1:7777")),
            listOf(sweep("b", "http://2.2.2.2:7777")),
        )
        assertEquals(2, merged.size)
    }

    @Test fun `null-id sweep hits are kept and not collapsed together`() {
        val merged = mergeDiscovered(
            emptyList(),
            listOf(sweep(null, "http://3.3.3.3:7777"), sweep(null, "http://4.4.4.4:7777")),
        )
        assertEquals(2, merged.size)
    }
}
