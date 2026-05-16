package network.luuk.horizontv.api

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ModelsTest {
    private val json = Json { ignoreUnknownKeys = true }

    @Test fun `user decodes from real server payload`() {
        val raw = """
            {"id":"u1","name":"Luuk","avatar":null,
             "preferences":{},"createdAt":1,"updatedAt":2}
        """.trimIndent()
        val u = json.decodeFromString(User.serializer(), raw)
        assertEquals("u1", u.id)
        assertEquals("Luuk", u.name)
        assertNull(u.avatar)
    }

    @Test fun `mediaItem decodes show row with null file-backed fields`() {
        val raw = """
            {"id":"s1","kind":"show","title":"Show","parentId":null,
             "sortYear":null,"season":null,"episode":null,
             "durationSec":null,"resolution":null,"videoCodec":null,
             "container":null,"hdr":null,"audioTracks":null,
             "subtitleTracks":null,"externalIds":null,
             "metadata":{"title":"Show","posterPath":"/p.jpg"}}
        """.trimIndent()
        val m = json.decodeFromString(MediaItem.serializer(), raw)
        assertEquals("s1", m.id)
        assertEquals("show", m.kind)
        assertNull(m.durationSec)
        assertEquals("/p.jpg", m.metadata?.posterPath)
    }
}
