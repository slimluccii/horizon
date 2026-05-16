package network.luuk.horizontv.ui

import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import network.luuk.horizontv.BuildConfig

/** Loads a TMDB poster via our server's image proxy so cold-start doesn't
 *  need an internet round-trip. `path` is the raw TMDB path the server
 *  returned in LooseMetadata.posterPath (e.g. `/abc123.jpg`). */
@Composable
fun Poster(path: String?, modifier: Modifier = Modifier.size(width = 160.dp, height = 240.dp)) {
    val clean = path?.trimStart('/')
    val url = if (clean.isNullOrEmpty()) null
              else "${BuildConfig.SERVER_URL}/metadata/image/w342/$clean"
    AsyncImage(
        model = url,
        contentDescription = null,
        contentScale = ContentScale.Crop,
        modifier = modifier,
    )
}
