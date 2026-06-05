package network.luuk.horizontv.discovery

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class SubnetSweepRunnerTest {
    @Test fun `sweep collects only hosts that probe positive`() = runBlocking {
        val good = "192.168.1.10"
        val results = sweepHosts(listOf(good, "192.168.1.11", "192.168.1.12")) { ip ->
            if (ip == good) DiscoveredServer("id", "Den", "http://$ip:7777", Source.Sweep, "0.1.0")
            else null
        }
        assertEquals(1, results.size)
        assertEquals(good, results[0].url.removePrefix("http://").removeSuffix(":7777"))
    }

    @Test fun `sweep returns empty when no host probes positive`() = runBlocking {
        val results = sweepHosts(listOf("192.168.1.10", "192.168.1.11")) { null }
        assertEquals(emptyList<DiscoveredServer>(), results)
    }

    @Test fun `a throwing probe is isolated and does not abort the sweep`() = runBlocking {
        val good = "192.168.1.10"
        val results = sweepHosts(listOf("192.168.1.9", good, "192.168.1.11")) { ip ->
            when (ip) {
                "192.168.1.9" -> throw RuntimeException("socket reset")
                good -> DiscoveredServer("id", "Den", "http://$ip:7777", Source.Sweep, "0.1.0")
                else -> null
            }
        }
        assertEquals(1, results.size)
        assertEquals(good, results[0].url.removePrefix("http://").removeSuffix(":7777"))
    }
}
