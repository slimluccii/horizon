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
fun BootScreen(onAuthed: () -> Unit, onNeedAuth: () -> Unit, onNeedPicker: () -> Unit) {
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
                // Now decide auth: validate any saved token via /auth/grant.
                val authDecision = network.luuk.horizontv.discovery.resolveAuth(
                    savedToken = state.store.readToken(),
                    fetchGrant = { token ->
                        // Provisionally set the resolved token on the api so the
                        // grant call carries it; cleared below on NeedAuth.
                        state.api!!.setToken(token)
                        try { state.api!!.getGrant().profiles }
                        catch (_: Throwable) { null }
                    },
                )
                when (authDecision) {
                    is network.luuk.horizontv.discovery.AuthDecision.Authed -> {
                        state.authenticate(authDecision.token, authDecision.profiles)
                        onAuthed()
                    }
                    network.luuk.horizontv.discovery.AuthDecision.NeedAuth -> {
                        state.store.clearToken()
                        state.api!!.setToken(null)
                        onNeedAuth()
                    }
                }
            }
            BootDecision.ShowPicker -> onNeedPicker()
        }
    }

    Box(Modifier.fillMaxSize()) { Text("Horizon", Modifier.align(Alignment.Center)) }
}
