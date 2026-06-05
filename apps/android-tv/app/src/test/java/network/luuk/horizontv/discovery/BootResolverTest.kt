package network.luuk.horizontv.discovery

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class BootResolverTest {
    private val saved = SavedServer(instanceId = "id-1", lastUrl = "http://1.1.1.1:7777", name = "Den")

    @Test fun `no saved server gives ShowPicker`() = runBlocking {
        val d = resolveBoot(null, probe = { null }, mdnsFind = { null })
        assertEquals(BootDecision.ShowPicker, d)
    }

    @Test fun `saved reachable with matching id gives Connect lastUrl`() = runBlocking {
        val d = resolveBoot(saved,
            probe = { url -> if (url == saved.lastUrl) "id-1" else null },
            mdnsFind = { null })
        assertEquals(BootDecision.Connect(saved.lastUrl, saved.instanceId, saved.name), d)
    }

    @Test fun `saved moved but mDNS refinds id gives Connect new url`() = runBlocking {
        val d = resolveBoot(saved,
            probe = { null },
            mdnsFind = { id -> if (id == "id-1") "http://2.2.2.2:7777" else null })
        assertEquals(BootDecision.Connect("http://2.2.2.2:7777", "id-1", "Den"), d)
    }

    @Test fun `saved gone and mDNS cannot find gives ShowPicker`() = runBlocking {
        val d = resolveBoot(saved, probe = { null }, mdnsFind = { null })
        assertEquals(BootDecision.ShowPicker, d)
    }

    @Test fun `probe answers with a different id then mDNS refinds the real one`() = runBlocking {
        // A different server now answers at the saved URL; we must not connect to
        // it — fall through to mDNS, which relocates the real server elsewhere.
        val d = resolveBoot(saved,
            probe = { "someone-else" },
            mdnsFind = { id -> if (id == "id-1") "http://3.3.3.3:7777" else null })
        assertEquals(BootDecision.Connect("http://3.3.3.3:7777", "id-1", "Den"), d)
    }

    private val savedNoId = SavedServer(instanceId = null, lastUrl = "http://5.5.5.5:7777", name = "Manual")

    @Test fun `null-id saved reconnects by URL when reachable and adopts the id`() = runBlocking {
        val d = resolveBoot(savedNoId,
            probe = { url -> if (url == savedNoId.lastUrl) "freshly-learned-id" else null },
            mdnsFind = { null })
        assertEquals(BootDecision.Connect(savedNoId.lastUrl, "freshly-learned-id", "Manual"), d)
    }

    @Test fun `null-id saved gives ShowPicker when unreachable`() = runBlocking {
        val d = resolveBoot(savedNoId, probe = { null }, mdnsFind = { null })
        assertEquals(BootDecision.ShowPicker, d)
    }
}
