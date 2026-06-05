package network.luuk.horizontv.discovery

enum class Source { Mdns, Sweep, Manual }

data class DiscoveredServer(
    val instanceId: String?,
    val name: String,
    val url: String,
    val source: Source,
    val version: String?,
)

/**
 * Merge mDNS + sweep results. Dedupe by instanceId — the mDNS entry wins (it
 * carries the friendly name). Entries with a null instanceId are never
 * collapsed together (we can't prove they're the same server).
 */
fun mergeDiscovered(
    mdns: List<DiscoveredServer>,
    sweep: List<DiscoveredServer>,
): List<DiscoveredServer> {
    val byId = LinkedHashMap<String, DiscoveredServer>()
    val noId = mutableListOf<DiscoveredServer>()
    for (s in mdns + sweep) {
        val id = s.instanceId
        if (id == null) { noId += s; continue }
        val existing = byId[id]
        if (existing == null || (existing.source != Source.Mdns && s.source == Source.Mdns)) {
            byId[id] = s
        }
    }
    return byId.values.toList() + noId
}
