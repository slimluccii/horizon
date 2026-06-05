package network.luuk.horizontv.discovery

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SubnetSweepTest {
    @Test fun `enumerates 254 hosts for a 24 prefix, excluding self, network, broadcast`() {
        val hosts = hostsForSweep("192.168.1.42", 24)!!
        assertEquals(253, hosts.size) // 254 usable minus self
        assertEquals(true, hosts.contains("192.168.1.1"))
        assertEquals(true, hosts.contains("192.168.1.254"))
        assertEquals(false, hosts.contains("192.168.1.42"))   // self excluded
        assertEquals(false, hosts.contains("192.168.1.0"))    // network
        assertEquals(false, hosts.contains("192.168.1.255"))  // broadcast
    }

    @Test fun `prefix below 24 is rejected as too large`() {
        assertNull(hostsForSweep("10.0.0.5", 16))
    }

    @Test fun `a 25 prefix only enumerates hosts within its own block`() {
        // .42 lives in the lower /25 block (.0/.127). Hosts must stay inside it.
        val hosts = hostsForSweep("192.168.1.42", 25)!!
        assertEquals(125, hosts.size) // 126 usable (.1..126) minus self
        assertEquals(true, hosts.contains("192.168.1.1"))
        assertEquals(true, hosts.contains("192.168.1.126"))
        assertEquals(false, hosts.contains("192.168.1.42"))  // self excluded
        assertEquals(false, hosts.contains("192.168.1.0"))   // network
        assertEquals(false, hosts.contains("192.168.1.127")) // broadcast
        assertEquals(false, hosts.contains("192.168.1.128")) // next subnet
        assertEquals(false, hosts.contains("192.168.1.200")) // next subnet
        assertEquals(false, hosts.contains("192.168.1.254")) // next subnet
    }

    @Test fun `a 25 prefix in the upper block stays in the upper block`() {
        // .200 lives in the upper /25 block (.128/.255).
        val hosts = hostsForSweep("192.168.1.200", 25)!!
        assertEquals(125, hosts.size) // 126 usable (.129..254) minus self
        assertEquals(true, hosts.contains("192.168.1.129"))
        assertEquals(true, hosts.contains("192.168.1.254"))
        assertEquals(false, hosts.contains("192.168.1.128")) // network
        assertEquals(false, hosts.contains("192.168.1.255")) // broadcast
        assertEquals(false, hosts.contains("192.168.1.200")) // self excluded
        assertEquals(false, hosts.contains("192.168.1.1"))   // lower subnet
        assertEquals(false, hosts.contains("192.168.1.127")) // lower subnet
    }

    @Test fun `prefix above 30 has no usable hosts and is rejected`() {
        assertNull(hostsForSweep("192.168.1.42", 31))
        assertNull(hostsForSweep("192.168.1.42", 32))
    }
}
