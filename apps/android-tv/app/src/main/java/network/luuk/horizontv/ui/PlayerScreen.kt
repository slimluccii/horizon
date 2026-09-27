@file:OptIn(androidx.media3.common.util.UnstableApi::class)

package network.luuk.horizontv.ui

import android.view.KeyEvent
import android.view.ViewGroup
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import network.luuk.horizontv.api.CreateSessionBody
import network.luuk.horizontv.api.Marker
import network.luuk.horizontv.api.ProgressSocket
import network.luuk.horizontv.api.SessionInfo
import network.luuk.horizontv.api.WatchProgress
import network.luuk.horizontv.app.LocalAppState

private const val RESUME_THRESHOLD_MS = 5_000
private const val SKIP_POLL_MS = 500L

@Composable
fun PlayerScreen(
    mediaId: String,
    resumeDefault: Boolean,
    onBack: () -> Unit,
) {
    val state = LocalAppState.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var progress by remember { mutableStateOf<WatchProgress?>(null) }
    var phase by remember { mutableStateOf(Phase.Loading) }
    var startMs by remember { mutableStateOf(0) }
    var session by remember { mutableStateOf<SessionInfo?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var sessionToken by remember { mutableStateOf<String?>(null) }
    var markers by remember { mutableStateOf<List<Marker>>(emptyList()) }
    var skippable by remember { mutableStateOf<Marker?>(null) }
    var controllerVisible by remember { mutableStateOf(false) }

    // Markers are an enhancement: fetched alongside progress, never gating playback.
    LaunchedEffect(mediaId) {
        markers = runCatching { state.api!!.getMarkers(mediaId) }.getOrDefault(emptyList())
    }

    // Fetch saved progress once.
    LaunchedEffect(mediaId) {
        val userId = state.activeProfile?.id
        if (userId == null) { phase = Phase.Starting; return@LaunchedEffect }
        try {
            val p = state.api!!.getProgress(userId, mediaId)
            if (p != null && p.positionMs > RESUME_THRESHOLD_MS && !p.watched) {
                progress = p
                if (resumeDefault) { startMs = p.positionMs; phase = Phase.Starting }
                else phase = Phase.AskResume
            } else {
                phase = Phase.Starting
            }
        } catch (_: Throwable) {
            phase = Phase.Starting
        }
    }

    // Create a session once we know the start position.
    LaunchedEffect(phase) {
        if (phase != Phase.Starting) return@LaunchedEffect
        try {
            session = state.api!!.createSession(
                CreateSessionBody(
                    mediaId = mediaId,
                    capabilities = state.capabilities,
                    userId = state.activeProfile?.id,
                    startPositionMs = if (startMs > 0) startMs else null,
                )
            )
            phase = Phase.Ready
        } catch (e: Throwable) {
            error = e.message
            phase = Phase.Error
        }
    }

    // Build + tear down ExoPlayer + socket lifecycle.
    // Tunneled video decode is deliberately not enabled here — the
    // Media3 1.5.1 API for it lives on DefaultTrackSelector.Parameters,
    // which would require constructing our own track selector. Left as a
    // post-v1 follow-up; playback still works correctly without it.
    val player = remember {
        ExoPlayer.Builder(context)
            .setSeekBackIncrementMs(10_000)
            .setSeekForwardIncrementMs(10_000)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                    .build(),
                /* handleAudioFocus = */ true,
            )
            .build()
    }

    val socket = remember {
        ProgressSocket(state.api!!.okHttp, state.serverUrl!!, authHeaders = { state.api!!.sessionHeaders(null) })
    }

    val sess = session
    LaunchedEffect(sess, phase) {
        if (phase != Phase.Ready) return@LaunchedEffect
        if (sess == null) return@LaunchedEffect
        val streamUrl = if (sess.streamUrl.startsWith("http")) sess.streamUrl
                        else state.serverUrl!! + sess.streamUrl
        // The stream needs the reconnect token, and the server only hands that out in session-ready.
        socket.connect(sess.wsUrl) { reconnectToken ->
            scope.launch {
                sessionToken = reconnectToken
                // The default data source cannot send the session bearer or the reconnect token.
                val dataSource = OkHttpDataSource.Factory(state.api!!.okHttp)
                    .setDefaultRequestProperties(state.api!!.sessionHeaders(reconnectToken))
                val source = DefaultMediaSourceFactory(dataSource).createMediaSource(MediaItem.fromUri(streamUrl))
                // A resumed session has no segments before its start, and a direct-play file starts at zero on its own.
                player.setMediaSource(source, startMs.toLong())
                player.prepare()
                player.playWhenReady = true
            }
        }
    }

    // Socket lifecycle is decoupled from the player lifecycle. The socket is
    // closed whenever the session id changes OR the phase transitions (e.g. to
    // Error), not only when the composable unmounts. This prevents socket leaks
    // during recomposition for non-player reasons and guarantees the WebSocket
    // is torn down on playback errors. socket.disconnect() is idempotent.
    DisposableEffect(sess?.sessionId, phase) {
        onDispose { socket.disconnect() }
    }

    // Periodic progress reports, every 5 s.
    // Use a DisposableEffect so the polling coroutine is explicitly cancelled
    // when the session changes or PlayerScreen exits, preventing coroutine
    // leaks and stalled delay() calls on a stale session/socket.
    DisposableEffect(sess, phase) {
        val progressJob = if (sess != null && phase == Phase.Ready) {
            scope.launch {
                while (true) {
                    delay(5_000)
                    val pos = player.currentPosition.toInt()
                    val dur = player.duration.takeIf { it > 0 }?.toInt() ?: 0
                    if (dur > 0) socket.reportProgress(pos, dur)
                }
            }
        } else null
        onDispose {
            /* Explicitly cancel the progress-reporting job when the session
             * changes or PlayerScreen exits, to prevent coroutine leaks and
             * stalled delay() calls. */
            progressJob?.cancel()
        }
    }

    // The skip chip follows the position more closely than the 5 s progress reports do.
    DisposableEffect(sess, phase, markers) {
        val skipJob = if (sess != null && phase == Phase.Ready && markers.isNotEmpty()) {
            scope.launch {
                while (true) {
                    skippable = skippableAt(markers, player.currentPosition)
                    delay(SKIP_POLL_MS)
                }
            }
        } else null
        onDispose { skipJob?.cancel(); skippable = null }
    }

    // Listen for fatal errors.
    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onPlayerError(e: PlaybackException) {
                error = e.message ?: "Playback failed (${e.errorCode})"
                phase = Phase.Error
            }
        }
        player.addListener(listener)
        onDispose {
            player.removeListener(listener)
            player.release()
            socket.disconnect()
            val id = session?.sessionId
            if (id != null) {
                scope.launch { runCatching { state.api!!.destroySession(id, sessionToken) } }
            }
        }
    }

    BackHandler { onBack() }

    Box(Modifier.fillMaxSize()) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { ctx ->
                // isControllerFullyVisible reports true while the controls are hidden, so the listener state decides.
                object : PlayerView(ctx) {
                    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
                        val target = skippable
                        if (target == null || !skipConsumesKey(event.keyCode, chipVisible = true, controllerVisible = controllerVisible)) {
                            return super.dispatchKeyEvent(event)
                        }
                        if (event.action == KeyEvent.ACTION_UP) player.seekTo(target.endMs.toLong())
                        return true
                    }
                }.apply {
                    useController = true
                    this.player = player
                    // Hiding the controls takes focus with them, and remote keys only reach a focused view.
                    isFocusable = true
                    setControllerVisibilityListener(PlayerView.ControllerVisibilityListener { visibility ->
                        controllerVisible = visibility == android.view.View.VISIBLE
                        if (!controllerVisible) requestFocus()
                    })
                    layoutParams = ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT,
                    )
                }
            },
        )

        val chip = skippable
        if (phase == Phase.Ready && chip != null && !controllerVisible) {
            Text(
                text = "Skip ${chip.kind}  ·  OK",
                color = Color.White,
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .padding(48.dp)
                    .background(Color.Black.copy(alpha = 0.6f), RoundedCornerShape(8.dp))
                    .padding(horizontal = 20.dp, vertical = 12.dp),
            )
        }

        if (phase == Phase.AskResume) {
            val p = progress
            if (p != null) {
                Column(
                    modifier = Modifier.align(Alignment.TopStart).padding(24.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Text("Resume from ${formatMs(p.positionMs)}?")
                    Button(onClick = {
                        startMs = p.positionMs
                        phase = Phase.Starting
                    }) { Text("Resume") }
                    TextButton(onClick = {
                        startMs = 0
                        phase = Phase.Starting
                    }) { Text("Start over") }
                }
            }
        }

        if (phase == Phase.Loading || phase == Phase.Starting) {
            Text("Loading…", Modifier.align(Alignment.Center))
        }
        if (phase == Phase.Error) {
            Column(
                modifier = Modifier.align(Alignment.Center),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text("Playback error: ${error ?: "unknown"}")
                Button(onClick = onBack) { Text("Back") }
            }
        }
    }
}

private enum class Phase { Loading, AskResume, Starting, Ready, Error }

private fun formatMs(ms: Int): String {
    val totalSec = ms / 1000
    val h = totalSec / 3600
    val m = (totalSec % 3600) / 60
    val s = totalSec % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
}
