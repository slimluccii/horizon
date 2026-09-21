package network.luuk.horizontv.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.tv.material3.ListItem
import kotlinx.coroutines.launch
import network.luuk.horizontv.api.PinResult
import network.luuk.horizontv.api.Profile
import network.luuk.horizontv.app.LocalAppState

@Composable
fun ProfileListScreen(
    onProfilePicked: () -> Unit,
    onSwitchServer: () -> Unit,
    onSignOut: () -> Unit,
) {
    val state = LocalAppState.current
    val scope = rememberCoroutineScope()
    val profiles = state.profiles
    var asking by remember { mutableStateOf<Profile?>(null) }

    asking?.let { profile ->
        PinEntry(
            profile = profile,
            onUnlocked = { state.setActiveProfile(profile); onProfilePicked() },
            onBack = { asking = null },
        )
        return
    }

    Column(
        Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Who's watching?")
        if (profiles.isEmpty()) {
            // Authenticated but no profiles granted to this device (e.g. the
            // acting profile was removed from the household on web). Not a
            // dead-end — Switch server / Sign out below recover.
            Text("No profiles available on this device. Ask the household owner to grant one, or sign out.")
        }
        LazyColumn(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            items(profiles, key = { it.id }) { p ->
                ListItem(
                    selected = false,
                    onClick = { if (p.hasPin) asking = p else { state.setActiveProfile(p); onProfilePicked() } },
                    headlineContent = { Text(p.name) },
                )
            }
            item(key = "switch_server") {
                ListItem(
                    selected = false,
                    // Switching servers ends this session entirely: clear the
                    // persisted token AND the in-memory session, so a stale
                    // token/profiles can't linger if the picker is backed out of.
                    onClick = { scope.launch { state.store.clearToken(); state.signOut(); onSwitchServer() } },
                    headlineContent = { Text("Switch server") },
                )
            }
            item(key = "sign_out") {
                ListItem(
                    selected = false,
                    onClick = { scope.launch { state.store.clearToken(); state.signOut(); onSignOut() } },
                    headlineContent = { Text("Sign out this TV") },
                )
            }
        }
    }
}

@Composable
private fun PinEntry(profile: Profile, onUnlocked: () -> Unit, onBack: () -> Unit) {
    val api = LocalAppState.current.api!!
    val scope = rememberCoroutineScope()
    var pin by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    Column(
        Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("PIN for ${profile.name}")
        OutlinedTextField(
            value = pin,
            onValueChange = { pin = it.filter(Char::isDigit).take(8) },
            label = { Text("PIN") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
        )
        if (error != null) Text(error!!)
        Button(enabled = !busy && pin.length >= 4, onClick = {
            busy = true; error = null
            scope.launch {
                try {
                    when (api.unlockProfile(profile.id, pin)) {
                        PinResult.Unlocked -> onUnlocked()
                        PinResult.Wrong -> { pin = ""; error = "Wrong PIN." }
                        PinResult.TooManyTries -> error = "Too many wrong PINs. Try again in a few minutes."
                    }
                } catch (_: Throwable) {
                    error = "Couldn’t reach the server."
                } finally { busy = false }
            }
        }) { Text("Continue") }
        TextButton(onClick = onBack) { Text("Back") }
    }
}
