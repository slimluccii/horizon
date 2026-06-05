package network.luuk.horizontv.discovery

/** A persisted server. [instanceId] is null when the server was saved without a
 *  known stable id (e.g. a manual entry added while the server was unreachable);
 *  such a server can only be reconnected by URL, not re-resolved via mDNS. */
data class SavedServer(val instanceId: String?, val lastUrl: String, val name: String)

sealed interface BootDecision {
    data class Connect(val url: String, val instanceId: String?, val name: String) : BootDecision
    data object ShowPicker : BootDecision
}

/**
 * Decide the start destination at boot. Pure over injected effects:
 *  - [probe]: GET url/health, return the reported instanceId or null.
 *  - [mdnsFind]: run mDNS, return the URL advertising the wanted instanceId, or null.
 */
suspend fun resolveBoot(
    saved: SavedServer?,
    probe: suspend (url: String) -> String?,
    mdnsFind: suspend (instanceId: String) -> String?,
): BootDecision {
    if (saved == null) return BootDecision.ShowPicker

    val probedId = probe(saved.lastUrl)

    // No stable id on file: reconnect purely by reachability. If the server now
    // reports an id, adopt it so future boots can re-resolve a moved server.
    if (saved.instanceId == null) {
        return if (probedId != null) {
            BootDecision.Connect(saved.lastUrl, probedId, saved.name)
        } else {
            BootDecision.ShowPicker
        }
    }

    if (probedId == saved.instanceId) {
        return BootDecision.Connect(saved.lastUrl, saved.instanceId, saved.name)
    }
    val refound = mdnsFind(saved.instanceId)
    if (refound != null) return BootDecision.Connect(refound, saved.instanceId, saved.name)
    return BootDecision.ShowPicker
}
