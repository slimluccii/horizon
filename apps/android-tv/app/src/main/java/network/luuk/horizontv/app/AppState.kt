package network.luuk.horizontv.app

import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import network.luuk.horizontv.api.Capabilities
import network.luuk.horizontv.api.HorizonApi
import network.luuk.horizontv.api.Profile
import network.luuk.horizontv.discovery.ServerStore
import network.luuk.horizontv.discovery.MdnsDiscovery

/**
 * Top-of-process singleton. Built in [network.luuk.horizontv.HorizonApp.onCreate]
 * and published to the Compose tree via [LocalAppState]. Holds:
 *  - `api`            — the [HorizonApi]; null until [connect] is called with a chosen server
 *  - `capabilities`   — the probed device caps; immutable for the process lifetime
 *  - `profiles`       — the granted profiles for the current session; empty until authenticated
 *  - `activeProfile`  — the profile the user is acting as; null until they pick one
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

    /** Granted profiles for the current session (from pairing poll / /auth/grant). */
    var profiles: List<Profile> by mutableStateOf(emptyList())
        private set

    /** The profile the user is currently acting as (drives X-Horizon-Profile).
     *  Backed by [_activeProfile]; mutated only via [setActiveProfile]/[signOut]
     *  to avoid a JVM setter-signature clash with [setActiveProfile]. */
    private var _activeProfile: Profile? by mutableStateOf(null)
    val activeProfile: Profile? get() = _activeProfile

    /** True once a session token is set on the api. */
    val isAuthenticated: Boolean get() = api?.let { token != null } ?: false

    @Volatile
    private var token: String? = null

    /** Build the API client once a server is chosen. */
    fun connect(url: String) {
        serverUrl = url
        api = HorizonApi(baseUrl = url)
    }

    /** Apply a session token + its granted profiles to the connected api. */
    fun authenticate(sessionToken: String, granted: List<Profile>) {
        token = sessionToken
        api?.setToken(sessionToken)
        profiles = granted
    }

    fun setActiveProfile(profile: Profile?) {
        _activeProfile = profile
        api?.setActiveProfile(profile?.id)
    }

    /** Drop the session (401 / sign-out): clears token, profiles, active profile. */
    fun signOut() {
        token = null
        profiles = emptyList()
        _activeProfile = null
        api?.setToken(null)
        api?.setActiveProfile(null)
    }
}

val LocalAppState = compositionLocalOf<AppState> {
    error("AppState not provided — forgot CompositionLocalProvider in MainActivity?")
}
