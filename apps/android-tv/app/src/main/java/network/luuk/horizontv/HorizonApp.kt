package network.luuk.horizontv

import android.app.Application
import network.luuk.horizontv.api.CapabilitiesProbe
import network.luuk.horizontv.api.HorizonApi
import network.luuk.horizontv.app.AppState

class HorizonApp : Application() {

    lateinit var state: AppState
        private set

    override fun onCreate() {
        super.onCreate()
        val api = HorizonApi(baseUrl = BuildConfig.SERVER_URL)
        val caps = CapabilitiesProbe.detect(this)
        state = AppState(api = api, capabilities = caps)
    }
}
