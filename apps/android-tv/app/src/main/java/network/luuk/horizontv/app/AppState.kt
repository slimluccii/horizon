package network.luuk.horizontv.app

import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import network.luuk.horizontv.api.Capabilities
import network.luuk.horizontv.api.HorizonApi
import network.luuk.horizontv.api.User
import network.luuk.horizontv.discovery.ServerStore
import network.luuk.horizontv.discovery.MdnsDiscovery

/**
 * Top-of-process singleton. Built in [network.luuk.horizontv.HorizonApp.onCreate]
 * and published to the Compose tree via [LocalAppState]. Holds:
 *  - `api`           — the [HorizonApi]; null until [connect] is called with a chosen server
 *  - `capabilities`  — the probed device caps; immutable for the process lifetime
 *  - `activeUser`    — the profile the user picked; null until they pick one
 */
class AppState(
    val capabilities: Capabilities,
    val store: ServerStore,
    val mdns: MdnsDiscovery,
) {
    var api: HorizonApi? by mutableStateOf(null)
        private set

    /** Base URL of the connected server — needed for stream + WebSocket URLs
     *  (PlayerScreen) that previously read BuildConfig.SERVER_URL. */
    var serverUrl: String? by mutableStateOf(null)
        private set

    var activeUser: User? by mutableStateOf(null)
        private set

    /** Build the API client once a server is chosen. */
    fun connect(url: String) {
        serverUrl = url
        api = HorizonApi(baseUrl = url)
    }

    @JvmName("updateActiveUser")
    fun setActiveUser(user: User?) {
        activeUser = user
        api?.setActiveUser(user?.id)
    }
}

val LocalAppState = compositionLocalOf<AppState> {
    error("AppState not provided — forgot CompositionLocalProvider in MainActivity?")
}
