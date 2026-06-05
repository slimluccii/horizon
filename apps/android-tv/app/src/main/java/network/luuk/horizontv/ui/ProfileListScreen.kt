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
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.tv.material3.ListItem
import androidx.tv.material3.ListItemDefaults
import kotlinx.coroutines.launch
import network.luuk.horizontv.api.CreateUserBody
import network.luuk.horizontv.api.User
import network.luuk.horizontv.app.LocalAppState

@Composable
fun ProfileListScreen(onUserPicked: () -> Unit) {
    val state = LocalAppState.current
    val scope = rememberCoroutineScope()

    var users by remember { mutableStateOf<List<User>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }

    var showAdd by remember { mutableStateOf(false) }
    var showDelete by remember { mutableStateOf<User?>(null) }

    suspend fun reload() {
        loading = true
        try { users = state.api!!.listUsers(); error = null }
        catch (e: Throwable) { error = e.message }
        finally { loading = false }
    }

    LaunchedEffect(Unit) { reload() }

    Column(
        Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Who's watching?")
        when {
            loading -> Text("Loading…")
            error != null -> Text("Error: $error")
            else -> LazyColumn(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                items(users, key = { it.id }) { user ->
                    ListItem(
                        selected = false,
                        onClick = {
                            state.setActiveUser(user)
                            onUserPicked()
                        },
                        onLongClick = { showDelete = user },
                        headlineContent = { Text(user.name) },
                        colors = ListItemDefaults.colors(),
                    )
                }
                item(key = "add") {
                    ListItem(
                        selected = false,
                        onClick = { showAdd = true },
                        headlineContent = { Text("+ Add profile") },
                    )
                }
            }
        }
    }

    if (showAdd) {
        AddProfileDialog(
            onDismiss = { showAdd = false },
            onSubmit = { name ->
                showAdd = false
                scope.launch {
                    try { state.api!!.createUser(CreateUserBody(name)); reload() }
                    catch (e: Throwable) { error = e.message }
                }
            },
        )
    }

    val toDelete = showDelete
    if (toDelete != null) {
        AlertDialog(
            onDismissRequest = { showDelete = null },
            confirmButton = {
                TextButton(onClick = {
                    showDelete = null
                    scope.launch {
                        try { state.api!!.deleteUser(toDelete.id); reload() }
                        catch (e: Throwable) { error = e.message }
                    }
                }) { Text("Delete") }
            },
            dismissButton = {
                TextButton(onClick = { showDelete = null }) { Text("Cancel") }
            },
            title = { Text("Delete profile?") },
            text = { Text("Remove \"${toDelete.name}\" and its watch history?") },
        )
    }
}

@Composable
private fun AddProfileDialog(onDismiss: () -> Unit, onSubmit: (String) -> Unit) {
    var name by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            Button(onClick = { if (name.isNotBlank()) onSubmit(name.trim()) }) { Text("Add") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        title = { Text("New profile") },
        text = {
            OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("Name") })
        },
    )
}
