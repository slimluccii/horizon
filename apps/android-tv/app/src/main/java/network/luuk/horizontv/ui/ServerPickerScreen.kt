package network.luuk.horizontv.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.tv.material3.ListItem
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import network.luuk.horizontv.app.LocalAppState
import network.luuk.horizontv.discovery.DiscoveredServer
import network.luuk.horizontv.discovery.SavedServer
import network.luuk.horizontv.discovery.Source
import network.luuk.horizontv.discovery.hostsForSweep
import network.luuk.horizontv.discovery.mergeDiscovered
import network.luuk.horizontv.discovery.normalizeServerUrl
import network.luuk.horizontv.discovery.probeHealth
import network.luuk.horizontv.discovery.sweepHosts
import network.luuk.horizontv.net.localIpv4AndPrefix
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

@Composable
fun ServerPickerScreen(onPicked: () -> Unit) {
    val state = LocalAppState.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var servers by remember { mutableStateOf<List<DiscoveredServer>>(emptyList()) }
    var scanning by remember { mutableStateOf(true) }
    var showManual by remember { mutableStateOf(false) }
    var scanNonce by remember { mutableStateOf(0) }

    fun choose(server: DiscoveredServer) {
        scope.launch {
            state.connect(server.url)
            state.store.save(
                SavedServer(
                    instanceId = server.instanceId ?: server.url,
                    lastUrl = server.url,
                    name = server.name,
                )
            )
            onPicked()
        }
    }

    LaunchedEffect(scanNonce) {
        scanning = true
        servers = emptyList()
        val sweepClient = OkHttpClient.Builder()
            .connectTimeout(800, TimeUnit.MILLISECONDS)
            .readTimeout(800, TimeUnit.MILLISECONDS)
            .build()

        // mDNS — collect up to ~4s into a snapshot list.
        val mdnsHits = withTimeoutOrNull(4_000) {
            state.mdns.discover().toList()
        } ?: emptyList()

        // Sweep — own /24 only.
        val (ip, prefix) = localIpv4AndPrefix(context) ?: (null to 0)
        val sweepHits = if (ip != null) {
            sweepHosts(hostsForSweep(ip, prefix) ?: emptyList()) { host ->
                probeHealth(sweepClient, "http://$host:7777", Source.Sweep)
            }
        } else emptyList()

        servers = mergeDiscovered(mdnsHits, sweepHits)
        scanning = false
    }

    Column(
        Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Find your Horizon server")
        if (scanning) Text("Scanning your network…")
        else if (servers.isEmpty()) Text("No servers found. Enter an address manually.")

        LazyColumn(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            items(servers, key = { it.url }) { server ->
                ListItem(
                    selected = false,
                    onClick = { choose(server) },
                    headlineContent = { Text(server.name) },
                    supportingContent = { Text("${server.url}  ·  ${server.source}") },
                )
            }
            item(key = "manual") {
                ListItem(
                    selected = false,
                    onClick = { showManual = true },
                    headlineContent = { Text("Enter address manually") },
                )
            }
            item(key = "rescan") {
                ListItem(
                    selected = false,
                    onClick = { scanNonce++ },
                    headlineContent = { Text("Rescan") },
                )
            }
        }
    }

    if (showManual) {
        ManualEntryDialog(
            onDismiss = { showManual = false },
            onSubmit = { raw ->
                val url = normalizeServerUrl(raw)
                showManual = false
                if (url != null) {
                    scope.launch {
                        val probeClient = OkHttpClient()
                        val hit = probeHealth(probeClient, url, Source.Manual)
                            ?: DiscoveredServer(null, url, url, Source.Manual, null)
                        choose(hit)
                    }
                }
            },
        )
    }
}

@Composable
private fun ManualEntryDialog(onDismiss: () -> Unit, onSubmit: (String) -> Unit) {
    var text by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            Button(onClick = { if (text.isNotBlank()) onSubmit(text) }) { Text("Connect") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        title = { Text("Server address") },
        text = {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                label = { Text("e.g. 192.168.1.10") },
            )
        },
    )
}
