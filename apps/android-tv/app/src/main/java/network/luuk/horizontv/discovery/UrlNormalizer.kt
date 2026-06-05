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
    val authority = withScheme.substring(schemeEnd)
    return if (authority.contains(':')) withScheme else "$withScheme:$DEFAULT_PORT"
}
