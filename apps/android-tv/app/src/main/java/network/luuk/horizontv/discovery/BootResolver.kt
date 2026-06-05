package network.luuk.horizontv.discovery

data class SavedServer(val instanceId: String, val lastUrl: String, val name: String)

sealed interface BootDecision {
    data class Connect(val url: String, val instanceId: String, val name: String) : BootDecision
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
    if (probe(saved.lastUrl) == saved.instanceId) {
        return BootDecision.Connect(saved.lastUrl, saved.instanceId, saved.name)
    }
    val refound = mdnsFind(saved.instanceId)
    if (refound != null) return BootDecision.Connect(refound, saved.instanceId, saved.name)
    return BootDecision.ShowPicker
}
