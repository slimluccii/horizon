package network.luuk.horizontv.net

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkAddress
import java.net.Inet4Address

/**
 * Best-effort current IPv4 address + prefix length from the active network.
 * Returns null when no IPv4 link is found (e.g. no connectivity).
 */
fun localIpv4AndPrefix(context: Context): Pair<String, Int>? {
    val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        ?: return null
    val network = cm.activeNetwork ?: return null
    val props = cm.getLinkProperties(network) ?: return null
    val v4: LinkAddress = props.linkAddresses.firstOrNull {
        it.address is Inet4Address && !it.address.isLoopbackAddress
    } ?: return null
    val host = v4.address.hostAddress ?: return null
    return host to v4.prefixLength
}
