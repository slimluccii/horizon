package network.luuk.horizontv.api

import okhttp3.Interceptor
import okhttp3.Response

/** Url of a TMDB image through the server's proxy; `path` is what the server sent in the metadata. */
fun posterUrl(serverUrl: String?, path: String?, size: String = "w342"): String? {
    val clean = path?.trimStart('/')
    if (serverUrl == null || clean.isNullOrEmpty()) return null
    return "$serverUrl/api/metadata/image/$size/$clean"
}

/** Adds the session headers to requests the REST client does not make itself, such as image loads. */
class SessionHeaderInterceptor(private val headers: () -> Map<String, String>) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request().newBuilder()
        headers().forEach { (name, value) -> request.header(name, value) }
        return chain.proceed(request.build())
    }
}
