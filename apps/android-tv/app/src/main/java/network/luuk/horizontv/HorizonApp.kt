package network.luuk.horizontv

import android.app.Application
import network.luuk.horizontv.api.CapabilitiesProbe
import network.luuk.horizontv.app.AppState
import network.luuk.horizontv.discovery.MdnsDiscovery
import network.luuk.horizontv.discovery.ServerStore

class HorizonApp : Application() {

    lateinit var state: AppState
        private set

    override fun onCreate() {
        super.onCreate()
        val caps = CapabilitiesProbe.detect(this)
        state = AppState(
            capabilities = caps,
            store = ServerStore(this),
            mdns = MdnsDiscovery(this),
        )
    }
}
