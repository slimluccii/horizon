package network.luuk.horizontv.discovery

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.core.edit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import java.io.File

class ServerStoreTest {
    private lateinit var file: File
    private lateinit var scope: CoroutineScope
    private lateinit var prefs: DataStore<Preferences>
    private lateinit var store: ServerStore

    @Before fun setUp() {
        file = File.createTempFile("server_store_test", ".preferences_pb").apply { delete() }
        scope = CoroutineScope(SupervisorJob())
        prefs = PreferenceDataStoreFactory.create(scope = scope) { file }
        store = ServerStore(prefs)
    }

    @After fun tearDown() {
        scope.cancel()
        file.delete()
    }

    @Test fun `read on empty store returns null`() = runBlocking {
        assertNull(store.read())
    }

    @Test fun `save then read round-trips all fields`() = runBlocking {
        val server = SavedServer(instanceId = "id-1", lastUrl = "http://1.1.1.1:7777", name = "Den")
        store.save(server)
        assertEquals(server, store.read())
    }

    @Test fun `read yields a null-id server when instance_id is missing`() = runBlocking {
        // A server is keyed by URL; the instanceId is optional (e.g. a manual
        // entry saved while the server was unreachable).
        prefs.edit { it[stringPreferencesKey("last_url")] = "http://1.1.1.1:7777" }
        assertEquals(
            SavedServer(instanceId = null, lastUrl = "http://1.1.1.1:7777", name = "http://1.1.1.1:7777"),
            store.read(),
        )
    }

    @Test fun `save with null id then read round-trips null id`() = runBlocking {
        val server = SavedServer(instanceId = null, lastUrl = "http://9.9.9.9:7777", name = "Manual")
        store.save(server)
        assertEquals(server, store.read())
    }

    @Test fun `save with null id clears a previously stored id`() = runBlocking {
        store.save(SavedServer(instanceId = "old", lastUrl = "http://9.9.9.9:7777", name = "Manual"))
        store.save(SavedServer(instanceId = null, lastUrl = "http://9.9.9.9:7777", name = "Manual"))
        assertEquals(
            SavedServer(instanceId = null, lastUrl = "http://9.9.9.9:7777", name = "Manual"),
            store.read(),
        )
    }

    @Test fun `read returns null when last_url is missing`() = runBlocking {
        prefs.edit { it[stringPreferencesKey("instance_id")] = "id-1" }
        assertNull(store.read())
    }

    @Test fun `read falls back to url when name is missing`() = runBlocking {
        prefs.edit {
            it[stringPreferencesKey("instance_id")] = "id-1"
            it[stringPreferencesKey("last_url")] = "http://1.1.1.1:7777"
        }
        assertEquals(
            SavedServer(instanceId = "id-1", lastUrl = "http://1.1.1.1:7777", name = "http://1.1.1.1:7777"),
            store.read(),
        )
    }

    @Test fun `updateUrl keeps id and name`() = runBlocking {
        store.save(SavedServer(instanceId = "id-1", lastUrl = "http://1.1.1.1:7777", name = "Den"))
        store.updateUrl("http://2.2.2.2:7777")
        assertEquals(
            SavedServer(instanceId = "id-1", lastUrl = "http://2.2.2.2:7777", name = "Den"),
            store.read(),
        )
    }
}
