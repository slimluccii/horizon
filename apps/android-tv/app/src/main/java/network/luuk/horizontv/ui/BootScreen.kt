package network.luuk.horizontv.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.withTimeoutOrNull
import network.luuk.horizontv.app.LocalAppState
import network.luuk.horizontv.discovery.BootDecision
import network.luuk.horizontv.discovery.resolveBoot
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

@Composable
fun BootScreen(onConnected: () -> Unit, onNeedPicker: () -> Unit) {
    val state = LocalAppState.current

    LaunchedEffect(Unit) {
        val saved = state.store.read()
        val client = OkHttpClient.Builder()
            .connectTimeout(2, TimeUnit.SECONDS)
            .readTimeout(2, TimeUnit.SECONDS)
            .build()

        val decision = resolveBoot(
            saved = saved,
            probe = { url ->
                network.luuk.horizontv.discovery.probeHealth(
                    client, url, network.luuk.horizontv.discovery.Source.Manual,
                )?.instanceId
            },
            mdnsFind = { wantedId ->
                withTimeoutOrNull(4_000) {
                    state.mdns.discover()
                        .mapNotNull { if (it.instanceId == wantedId) it.url else null }
                        .first()
                }
            },
        )

        when (decision) {
            is BootDecision.Connect -> {
                state.connect(decision.url)
                if (saved == null || saved.lastUrl != decision.url) {
                    state.store.save(
                        network.luuk.horizontv.discovery.SavedServer(
                            decision.instanceId, decision.url, decision.name,
                        )
                    )
                }
                onConnected()
            }
            BootDecision.ShowPicker -> onNeedPicker()
        }
    }

    Box(Modifier.fillMaxSize()) { Text("Horizon", Modifier.align(Alignment.Center)) }
}
