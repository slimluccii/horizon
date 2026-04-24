package network.luuk.horizontv.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import network.luuk.horizontv.api.Collection
import network.luuk.horizontv.api.ContinueWatchingItem
import network.luuk.horizontv.api.MediaItem
import network.luuk.horizontv.api.ShowSummary
import network.luuk.horizontv.app.LocalAppState

enum class LibraryTab { Movies, Series, Collections }

@Composable
fun LibraryScreen(
    onShowClick: (String) -> Unit,
    onMovieClick: (mediaId: String, resume: Boolean) -> Unit,
) {
    val state = LocalAppState.current
    var movies by remember { mutableStateOf<List<MediaItem>>(emptyList()) }
    var shows by remember { mutableStateOf<List<ShowSummary>>(emptyList()) }
    var collections by remember { mutableStateOf<List<Collection>>(emptyList()) }
    var cw by remember { mutableStateOf<List<ContinueWatchingItem>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    var tab by remember { mutableStateOf(LibraryTab.Movies) }

    LaunchedEffect(Unit) {
        try {
            coroutineScope {
                val mD  = async { state.api.listMovies() }
                val sD  = async { state.api.listShows() }
                val cD  = async { state.api.listCollections() }
                val cwD = async {
                    state.activeUser?.id?.let { state.api.continueWatching(it) } ?: emptyList()
                }
                movies = mD.await()
                shows = sD.await()
                collections = cD.await()
                cw = cwD.await()
            }
        } catch (e: Throwable) { error = e.message }
        loading = false
    }

    Column(
        Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            LibraryTab.values().forEach { t ->
                FilterChip(
                    selected = tab == t,
                    onClick = { tab = t },
                    label = { Text(t.name) },
                )
            }
        }

        if (cw.isNotEmpty()) {
            Text("Continue watching")
            LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                items(cw, key = { it.mediaId }) { item ->
                    Column(
                        modifier = Modifier.width(220.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Poster(
                            path = item.media.metadata?.posterPath,
                            modifier = Modifier.size(width = 220.dp, height = 124.dp),
                        )
                        Text(item.media.title, maxLines = 1)
                        Text("${item.percent}%")
                        TextButton(onClick = { onMovieClick(item.mediaId, true) }) {
                            Text("Resume")
                        }
                    }
                }
            }
        }

        when {
            loading -> Text("Loading library…")
            error != null -> Text("Error: $error")
            else -> when (tab) {
                LibraryTab.Movies       -> MovieGrid(movies, onMovieClick = { onMovieClick(it.id, false) })
                LibraryTab.Series       -> ShowGrid(shows, onShowClick = { onShowClick(it.id) })
                LibraryTab.Collections  -> CollectionList(collections, onMovieClick = { onMovieClick(it.id, false) })
            }
        }
    }
}

@Composable
private fun MovieGrid(items: List<MediaItem>, onMovieClick: (MediaItem) -> Unit) {
    if (items.isEmpty()) { Text("No movies."); return }
    LazyVerticalGrid(
        columns = GridCells.Adaptive(minSize = 180.dp),
        horizontalArrangement = Arrangement.spacedBy(16.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        items(items, key = { it.id }) { m ->
            Column(
                modifier = Modifier.clickableTile { onMovieClick(m) },
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Poster(m.metadata?.posterPath)
                Text(m.title, maxLines = 2)
                m.sortYear?.let { Text(it.toString()) }
            }
        }
    }
}

@Composable
private fun ShowGrid(items: List<ShowSummary>, onShowClick: (ShowSummary) -> Unit) {
    if (items.isEmpty()) { Text("No shows."); return }
    LazyVerticalGrid(
        columns = GridCells.Adaptive(minSize = 180.dp),
        horizontalArrangement = Arrangement.spacedBy(16.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        items(items, key = { it.id }) { s ->
            Column(
                modifier = Modifier.clickableTile { onShowClick(s) },
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Poster(s.metadata?.posterPath)
                Text(s.title, maxLines = 2)
                Text("${s.seasons.size} season(s)")
            }
        }
    }
}

@Composable
private fun CollectionList(items: List<Collection>, onMovieClick: (MediaItem) -> Unit) {
    if (items.isEmpty()) { Text("No collections."); return }
    Column(verticalArrangement = Arrangement.spacedBy(24.dp)) {
        items.forEach { col ->
            Text(col.name)
            LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                items(col.movies, key = { it.id }) { m ->
                    Column(
                        modifier = Modifier.clickableTile { onMovieClick(m) },
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Poster(m.metadata?.posterPath)
                        Text(m.title, maxLines = 2)
                    }
                }
            }
        }
    }
}

/** Tiny helper so each tile gets focusable click handling. Wraps
 *  [androidx.compose.foundation.clickable] — good enough for D-pad nav. */
private fun Modifier.clickableTile(onClick: () -> Unit): Modifier =
    this.clickable { onClick() }
