package network.luuk.horizontv

import android.app.Application
import coil3.ImageLoader
import coil3.PlatformContext
import coil3.SingletonImageLoader
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import network.luuk.horizontv.api.SessionHeaderInterceptor
import okhttp3.OkHttpClient
import network.luuk.horizontv.api.CapabilitiesProbe
import network.luuk.horizontv.app.AppState
import network.luuk.horizontv.discovery.MdnsDiscovery
import network.luuk.horizontv.discovery.ServerStore

class HorizonApp : Application(), SingletonImageLoader.Factory {

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

    // The image proxy only serves someone who is logged in, so image loads carry the session like every other call.
    override fun newImageLoader(context: PlatformContext): ImageLoader {
        val client = OkHttpClient.Builder()
            .addInterceptor(SessionHeaderInterceptor { state.api?.sessionHeaders(null) ?: emptyMap() })
            .build()
        return ImageLoader.Builder(context)
            .components { add(OkHttpNetworkFetcherFactory(callFactory = { client })) }
            .build()
    }
}
