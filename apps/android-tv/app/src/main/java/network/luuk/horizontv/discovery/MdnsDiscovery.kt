package network.luuk.horizontv.discovery

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.util.Log
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import java.util.concurrent.ConcurrentLinkedQueue

private const val SERVICE_TYPE = "_horizon._tcp."
private const val TAG = "MdnsDiscovery"

/**
 * Map a resolved mDNS service to a [DiscoveredServer]. Pure so it can be
 * unit-tested without NsdManager.
 *
 * Returns null when [host] is null — an unresolved address yields no usable URL,
 * so the result is dropped. Otherwise builds `http://host:port`, reads the
 * `id`/`name`/`v` TXT records (UTF-8), and falls back to [serviceName] when the
 * `name` TXT record is absent.
 */
fun toDiscoveredServer(
    host: String?,
    port: Int,
    serviceName: String,
    attributes: Map<String, ByteArray>,
): DiscoveredServer? {
    if (host == null) return null
    fun txt(key: String) = attributes[key]?.toString(Charsets.UTF_8)
    return DiscoveredServer(
        instanceId = txt("id"),
        name = txt("name") ?: serviceName,
        url = "http://$host:$port",
        source = Source.Mdns,
        version = txt("v"),
    )
}

/**
 * Discover `_horizon._tcp` services via NsdManager. Emits a [DiscoveredServer]
 * per resolved service. Resolves are serialized through a queue because
 * NsdManager cannot resolve concurrently before API 31. Holds a multicast lock
 * for the lifetime of the flow collection.
 */
class MdnsDiscovery(context: Context) {
    private val appContext = context.applicationContext
    private val nsd = appContext.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val wifi = appContext.getSystemService(Context.WIFI_SERVICE) as WifiManager

    fun discover(): Flow<DiscoveredServer> = callbackFlow {
        val lock = wifi.createMulticastLock("horizon-mdns").apply {
            setReferenceCounted(false)
            runCatching { acquire() }
        }

        // Serialize resolves: NsdManager rejects concurrent resolveService calls.
        val pending = ConcurrentLinkedQueue<NsdServiceInfo>()
        var resolving = false

        fun resolveNext() {
            if (resolving) return
            val info = pending.poll() ?: return
            resolving = true
            nsd.resolveService(info, object : NsdManager.ResolveListener {
                override fun onResolveFailed(s: NsdServiceInfo, code: Int) {
                    resolving = false
                    resolveNext()
                }
                override fun onServiceResolved(s: NsdServiceInfo) {
                    toDiscoveredServer(
                        host = s.host?.hostAddress,
                        port = s.port,
                        serviceName = s.serviceName,
                        attributes = s.attributes,
                    )?.let { trySend(it) }
                    resolving = false
                    resolveNext()
                }
            })
        }

        val discoveryListener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(t: String) {}
            override fun onDiscoveryStopped(t: String) {}
            override fun onStartDiscoveryFailed(t: String, code: Int) { close() }
            override fun onStopDiscoveryFailed(t: String, code: Int) {}
            override fun onServiceFound(info: NsdServiceInfo) {
                pending.add(info)
                resolveNext()
            }
            override fun onServiceLost(info: NsdServiceInfo) {}
        }

        try {
            nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener)
        } catch (e: Throwable) {
            Log.w(TAG, "discover failed", e); close()
        }

        awaitClose {
            runCatching { nsd.stopServiceDiscovery(discoveryListener) }
            runCatching { if (lock.isHeld) lock.release() }
        }
    }
}
