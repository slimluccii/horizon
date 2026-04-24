package network.luuk.horizontv.app

import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import network.luuk.horizontv.api.Capabilities
import network.luuk.horizontv.api.HorizonApi
import network.luuk.horizontv.api.User

/**
 * Top-of-process singleton. Built in [network.luuk.horizontv.HorizonApp.onCreate]
 * and published to the Compose tree via [LocalAppState]. Holds:
 *  - `api`           — the [HorizonApi] with the configured base URL
 *  - `capabilities`  — the probed device caps; immutable for the process lifetime
 *  - `activeUser`    — the profile the user picked; null until they pick one
 */
class AppState(
    val api: HorizonApi,
    val capabilities: Capabilities,
) {
    var activeUser: User? by mutableStateOf(null)
        private set

    @JvmName("updateActiveUser")
    fun setActiveUser(user: User?) {
        activeUser = user
        api.setActiveUser(user?.id)
    }
}

val LocalAppState = compositionLocalOf<AppState> {
    error("AppState not provided — forgot CompositionLocalProvider in MainActivity?")
}
