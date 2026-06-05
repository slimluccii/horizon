package network.luuk.horizontv.discovery

import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope

/**
 * Enumerate sweepable host IPs for [selfIp] on a /[prefix] network. Returns null
 * when the prefix is wider than /24 (too many hosts to brute-force) or outside the
 * usable /24../30 range. The host range is derived from the prefix so subnets
 * narrower than /24 only enumerate their own block — never IPs in a neighbouring
 * subnet. Excludes the network address, broadcast address, and self.
 */
fun hostsForSweep(selfIp: String, prefix: Int): List<String>? {
    // Reject prefixes wider than /24 (too many hosts) and ones with no usable
    // hosts (/31, /32) or invalid values.
    if (prefix < 24 || prefix > 30) return null
    val octets = selfIp.split('.')
    if (octets.size != 4) return null
    val base = "${octets[0]}.${octets[1]}.${octets[2]}"
    val selfLast = octets[3].toIntOrNull() ?: return null
    if (selfLast < 0 || selfLast > 255) return null

    // The last [prefix - 24] bits of the network are fixed; the remaining low
    // bits identify the host within this subnet's last-octet block.
    val blockSize = 1 shl (32 - prefix)            // e.g. /24 -> 256, /25 -> 128
    val network = selfLast - (selfLast % blockSize) // first address of the block
    val broadcast = network + blockSize - 1
    // Usable hosts exclude network and broadcast; exclude self too.
    return ((network + 1)..(broadcast - 1))
        .filter { it != selfLast }
        .map { "$base.$it" }
}

/**
 * Probe every host concurrently via [probe] and return the positive hits. The
 * caller supplies [probe] (normally a `/health` call with a short timeout
 * client); injection keeps this unit-testable without real sockets.
 *
 * Each probe is isolated with [runCatching]: a throwing probe is treated as a
 * miss for that host rather than aborting the whole sweep. This keeps a single
 * flaky host (DNS failure, socket reset, unexpected exception) from cancelling
 * its siblings via [awaitAll].
 */
suspend fun sweepHosts(
    hosts: List<String>,
    probe: suspend (ip: String) -> DiscoveredServer?,
): List<DiscoveredServer> = coroutineScope {
    hosts.map { ip -> async { runCatching { probe(ip) }.getOrNull() } }
        .awaitAll()
        .filterNotNull()
}
