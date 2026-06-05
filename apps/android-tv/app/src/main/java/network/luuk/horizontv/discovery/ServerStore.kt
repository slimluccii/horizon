package network.luuk.horizontv.discovery

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.first

private val Context.serverDataStore: DataStore<Preferences> by preferencesDataStore("horizon_server")

/** Persists the chosen server so relaunches skip the picker. */
class ServerStore internal constructor(private val store: DataStore<Preferences>) {
    constructor(context: Context) : this(context.serverDataStore)

    private val idKey = stringPreferencesKey("instance_id")
    private val urlKey = stringPreferencesKey("last_url")
    private val nameKey = stringPreferencesKey("name")

    suspend fun read(): SavedServer? {
        val prefs = store.data.first()
        // A saved server is keyed by its URL; the instanceId is optional.
        val url = prefs[urlKey] ?: return null
        val name = prefs[nameKey] ?: url
        return SavedServer(prefs[idKey], url, name)
    }

    suspend fun save(server: SavedServer) {
        store.edit { prefs ->
            val id = server.instanceId
            if (id != null) prefs[idKey] = id else prefs.remove(idKey)
            prefs[urlKey] = server.lastUrl
            prefs[nameKey] = server.name
        }
    }

    /** Update just the URL after a re-resolve, keeping id + name. */
    suspend fun updateUrl(url: String) {
        store.edit { prefs -> prefs[urlKey] = url }
    }
}
