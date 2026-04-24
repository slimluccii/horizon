package network.luuk.horizontv.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.tv.material3.ListItem
import network.luuk.horizontv.api.MediaItem
import network.luuk.horizontv.api.ShowSummary
import network.luuk.horizontv.app.LocalAppState

@Composable
fun ShowDetailScreen(
    showId: String,
    onPlayEpisode: (String) -> Unit,
) {
    val state = LocalAppState.current
    var show by remember { mutableStateOf<ShowSummary?>(null) }
    var season by remember { mutableStateOf<Int?>(null) }
    var episodes by remember { mutableStateOf<List<MediaItem>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(showId) {
        try {
            val s = state.api.getShow(showId)
            show = s
            // Let the season-keyed LaunchedEffect below fetch episodes — it
            // fires on the null→firstSeason transition. Doing the fetch here
            // too would double the initial request.
            season = s.seasons.firstOrNull()?.number
        } catch (e: Throwable) { error = e.message }
    }

    LaunchedEffect(season) {
        val s = season ?: return@LaunchedEffect
        try { episodes = state.api.listEpisodes(showId, s) }
        catch (e: Throwable) { error = e.message }
    }

    Column(
        Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        val s = show
        when {
            error != null -> Text("Error: $error")
            s == null -> Text("Loading…")
            else -> {
                Text(s.metadata?.title ?: s.title)
                s.metadata?.overview?.let { Text(it, maxLines = 4) }

                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    s.seasons.forEach { ss ->
                        FilterChip(
                            selected = ss.number == season,
                            onClick = { season = ss.number },
                            label = { Text("Season ${ss.number}") },
                        )
                    }
                }

                LazyColumn(
                    modifier = Modifier.fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    items(episodes, key = { it.id }) { ep ->
                        ListItem(
                            selected = false,
                            onClick = { onPlayEpisode(ep.id) },
                            headlineContent = {
                                Text(buildString {
                                    ep.episode?.let { append("E").append(it).append(" · ") }
                                    append(ep.title)
                                })
                            },
                            supportingContent = {
                                val mins = ((ep.durationSec ?: 0.0) / 60).toInt()
                                Text("${mins}m")
                            },
                        )
                    }
                }
            }
        }
    }
}
