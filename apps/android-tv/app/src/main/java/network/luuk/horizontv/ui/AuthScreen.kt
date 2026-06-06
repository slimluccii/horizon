package network.luuk.horizontv.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import network.luuk.horizontv.api.ApiException
import network.luuk.horizontv.api.PairPoll
import network.luuk.horizontv.app.LocalAppState

private enum class Mode { Pairing, Password }

@Composable
fun AuthScreen(onAuthed: () -> Unit) {
    val state = LocalAppState.current
    val api = state.api!!
    var mode by remember { mutableStateOf(Mode.Pairing) }

    Column(
        Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (mode == Mode.Pairing) {
            PairingView(onAuthed = onAuthed, onPassword = { mode = Mode.Password })
        } else {
            PasswordView(onAuthed = onAuthed, onPairing = { mode = Mode.Pairing })
        }
    }
}

@Composable
private fun PairingView(onAuthed: () -> Unit, onPassword: () -> Unit) {
    val state = LocalAppState.current
    val api = state.api!!
    var code by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    // Start a code + poll loop; re-mints on expiry. Cancelled on leaving the view.
    DisposableEffect(Unit) {
        val job = kotlinx.coroutines.MainScope().launch {
            while (isActive) {
                try {
                    val started = api.pairStart()
                    code = started.code
                    error = null
                    // Poll this code until approved or expired.
                    pollLoop@ while (isActive) {
                        delay(3_000)
                        val r: PairPoll? = try {
                            api.pairPoll(started.code)
                        } catch (e: ApiException) {
                            if (e.status == 410) break@pollLoop // expired → re-mint
                            error = "Couldn’t reach the server."; delay(2_000); null
                        } catch (_: Throwable) {
                            error = "Couldn’t reach the server."; delay(2_000); null
                        }
                        when (r) {
                            is PairPoll.Authed -> {
                                state.authenticate(r.result.token, r.result.profiles)
                                state.store.saveToken(r.result.token)
                                onAuthed(); return@launch
                            }
                            PairPoll.Pending, null -> { /* keep polling */ }
                        }
                    }
                } catch (_: Throwable) {
                    error = "Couldn’t reach the server."
                    delay(3_000)
                }
            }
        }
        onDispose { job.cancel() }
    }

    Text("Link this TV")
    Text(code ?: "…", Modifier.padding(8.dp))
    Text("On your phone: Horizon → Settings → Household → Link a TV, then enter this code.")
    if (error != null) Text(error!!)
    TextButton(onClick = onPassword) { Text("Enter password instead") }
}

@Composable
private fun PasswordView(onAuthed: () -> Unit, onPairing: () -> Unit) {
    val state = LocalAppState.current
    val api = state.api!!
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    Text("Sign in")
    OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("Name") })
    OutlinedTextField(value = password, onValueChange = { password = it }, label = { Text("Password") })
    if (error != null) Text(error!!)
    Button(enabled = !busy, onClick = {
        busy = true; error = null
        scope.launch {
            try {
                val res = api.login(name.trim(), password)
                api.setToken(res.token)
                val profiles = runCatching { api.getGrant().profiles }.getOrDefault(emptyList())
                state.authenticate(res.token, profiles.ifEmpty { listOf(network.luuk.horizontv.api.Profile(res.user.id, res.user.name, res.user.avatar)) })
                state.store.saveToken(res.token)
                onAuthed()
            } catch (e: ApiException) {
                error = when (e.code) {
                    "invalid-credentials" -> "Wrong name or password."
                    "account-locked" -> "Account temporarily locked."
                    "rate-limited" -> "Too many attempts — wait a moment."
                    else -> e.message
                }
            } finally { busy = false }
        }
    }) { Text("Sign in") }
    TextButton(onClick = onPairing) { Text("Use a code instead") }
}
