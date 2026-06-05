package network.luuk.horizontv.discovery

private const val DEFAULT_PORT = 7777

/**
 * Normalize user/manual input into `http://host:port`. Adds the http scheme if
 * missing, appends the default port if none given, trims a trailing slash.
 * Returns null for blank input.
 */
fun normalizeServerUrl(input: String): String? {
    val trimmed = input.trim().trimEnd('/')
    if (trimmed.isEmpty()) return null
    val withScheme = if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
        trimmed
    } else {
        "http://$trimmed"
    }
    val schemeEnd = withScheme.indexOf("://") + 3
    val rest = withScheme.substring(schemeEnd)
    // Only the host[:port] segment matters for the port check — a path/query
    // after the first '/' must not be mistaken for (or fused onto) the port.
    val hostEnd = rest.indexOfFirst { it == '/' || it == '?' }.let { if (it == -1) rest.length else it }
    val host = rest.substring(0, hostEnd)
    if (host.contains(':')) return withScheme
    // Insert the default port right after the host, before any path/query.
    return withScheme.substring(0, schemeEnd) + host + ":$DEFAULT_PORT" + rest.substring(hostEnd)
}
