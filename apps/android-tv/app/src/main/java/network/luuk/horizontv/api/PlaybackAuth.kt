package network.luuk.horizontv.api

/**
 * Headers for the requests a playback session makes outside the REST client:
 * the stream, its segments and the WebSocket upgrade. The server wants the
 * session bearer and, for media, the per-session reconnect token.
 */
fun playbackHeaders(token: String?, profileId: String?, reconnectToken: String?): Map<String, String> = buildMap {
    token?.let { put("Authorization", "Bearer $it") }
    profileId?.let { put("X-Horizon-Profile", it) }
    reconnectToken?.let { put("X-Reconnect-Token", it) }
}
