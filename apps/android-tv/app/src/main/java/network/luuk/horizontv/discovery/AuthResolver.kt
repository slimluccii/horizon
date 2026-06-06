package network.luuk.horizontv.discovery

import network.luuk.horizontv.api.Profile

sealed interface AuthDecision {
    data class Authed(val token: String, val profiles: List<Profile>) : AuthDecision
    data object NeedAuth : AuthDecision
}

/**
 * Decide post-connect auth state. [fetchGrant] validates [savedToken] against the
 * server (GET /auth/grant) and returns the granted profiles, or null when the
 * token is rejected/unreachable. Pure over the injected effect.
 */
suspend fun resolveAuth(
    savedToken: String?,
    fetchGrant: suspend (token: String) -> List<Profile>?,
): AuthDecision {
    if (savedToken == null) return AuthDecision.NeedAuth
    val profiles = fetchGrant(savedToken)
    return if (profiles != null) AuthDecision.Authed(savedToken, profiles) else AuthDecision.NeedAuth
}
