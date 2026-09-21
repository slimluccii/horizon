package network.luuk.horizontv.api

import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Decodes what the server really sends. The fixture is written by the server's
 * media.contract.test.ts, which fails when the wire shape changes.
 */
class ModelsContractTest {
    private val json = Json { ignoreUnknownKeys = true }
    private val items: List<MediaItem> by lazy {
        val raw = javaClass.getResource("/contract/media-items.json")!!.readText()
        json.decodeFromString(ListSerializer(MediaItem.serializer()), raw)
    }

    @Test fun `movie carries its year, runtime and tracks`() {
        val movie = items[0]
        assertEquals("movie", movie.kind)
        assertEquals(2021, movie.year)
        assertEquals(9300.5, movie.durationSec!!, 0.0)
        assertEquals("eac3", movie.audioTracks!!.single().codec)
        assertEquals(true, movie.hdr!!.hdr10)
        assertEquals("/dune.jpg", movie.metadata?.posterPath)
    }

    @Test fun `show has no file-backed fields`() {
        val show = items[1]
        assertEquals("show", show.kind)
        assertNull(show.year)
        assertNull(show.durationSec)
        assertNull(show.audioTracks)
    }

    @Test fun `episode points at its show and knows a multi-episode range`() {
        val episode = items[2]
        assertEquals("show1", episode.parentId)
        assertEquals(1, episode.season)
        assertEquals(1, episode.episode)
        assertEquals(2, episode.episodeEnd)
    }
}
