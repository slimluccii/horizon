# Multi-Household Auth (Android TV) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Authenticate the Android TV client against the household server — TV pairing (+ password fallback), persisted session token, granted-profile picker, and `Authorization: Bearer` + `X-Horizon-Profile` per request, replacing the legacy `X-Horizon-User` header.

**Architecture:** `HorizonApi` gains a bearer token + active-profile header and pairing/login/grant methods; `AppState` holds token + granted profiles + active profile; `ServerStore` persists the token; a reworked profile picker + new `AuthScreen` + extended boot flow wire it together. Pure logic (API headers, auth decision, token store) is TDD'd with MockWebServer/DataStore; Compose screens are build-verified (no Robolectric in this project, as with discovery).

**Tech Stack:** Kotlin, Jetpack Compose + tv-material, OkHttp + kotlinx-serialization, Jetpack DataStore, Navigation-Compose. JUnit4 + OkHttp MockWebServer.

**Spec:** `docs/superpowers/specs/2026-06-06-multi-household-auth-android-design.md`

**Conventions (verified in-repo):**
- `HorizonApi` (`api/HorizonApi.kt`): one `exec()` runs every call on `Dispatchers.IO`, throws `ApiException(status, code, message)` on `!isSuccessful`. Currently sets `X-Horizon-User: activeUserId` — being removed.
- Models in `api/Models.kt` (`@Serializable data class`, `Json { ignoreUnknownKeys = true }`).
- Tests are JVM unit under `app/src/test/java/network/luuk/horizontv/...`, co-located by package. MockWebServer pattern: see `discovery/HealthProbeTest.kt`. DataStore round-trip: `discovery/ServerStoreTest.kt`. Pure decision logic: `discovery/BootResolverTest.kt`.
- Build/test (from `apps/android-tv`), JDK17 toolchain: `export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"` then append `-Porg.gradle.java.installations.paths=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home` to every `./gradlew` call. Unit tests: `./gradlew :app:testDebugUnitTest <flags>`. Build: `./gradlew :app:assembleDebug <flags>`. Single test class: add `--tests '*ClassName'`.
- Compose/NsdManager/DataStore-wiring screens have no unit tests (no Robolectric) — verified by a clean `assembleDebug`, as in the discovery feature.

**Out of scope:** server + web (done); creating/deleting profiles on TV; EncryptedSharedPreferences hardening.

---

## File structure

- `api/Models.kt` — add `Profile`, `PairStartResult`, `AuthResult`, `GrantResult`, `LoginBody`; (`User` reused).
- `api/HorizonApi.kt` — token + `X-Horizon-Profile`; `Unauthorized`; `pairStart`/`pairPoll`/`login`/`getGrant`; drop `X-Horizon-User` + user CRUD.
- `app/AppState.kt` — `token`/`profiles`/`activeProfile`; `authenticate`/`setActiveProfile`/`signOut`; drop `activeUser`.
- `discovery/ServerStore.kt` (+ test) — persist/clear `token`.
- `discovery/AuthResolver.kt` (+ test, new) — pure post-connect auth decision.
- `ui/BootScreen.kt` — after connect, run the auth decision.
- `ui/AuthScreen.kt` (new) — pairing + password fallback.
- `ui/ProfileListScreen.kt` — granted-profile picker (no add/delete) + switch-profile / sign-out.
- `ui/LibraryScreen.kt`, `ui/PlayerScreen.kt` — use active profile.
- `ui/Routes.kt`, `MainActivity.kt` — `AUTH` route + nav + 401 → auth.

---

# Phase 1 — API, models, state, storage

### Task 1: Auth models

**Files:**
- Modify: `apps/android-tv/app/src/main/java/network/luuk/horizontv/api/Models.kt`

**Context:** Plain `@Serializable` data classes consumed by the API methods in Task 2 (covered by those tests). `User` already exists and is reused.

- [ ] **Step 1: Implement**

Append to `api/Models.kt` (the file already imports `kotlinx.serialization.*`; `JsonElement` is already imported for `User`):

```kotlin
@Serializable
data class Profile(val id: String, val name: String, val avatar: String? = null)

@Serializable
data class PairStartResult(val code: String, val expiresAt: Long)

/** Response of /auth/pair/poll (when approved) and /auth/login. `profiles` is
 *  present on the pairing poll (granted set); login returns it empty and the
 *  caller follows up with /auth/grant. */
@Serializable
data class AuthResult(
    val token: String,
    val user: User,
    val grant: List<String> = emptyList(),
    val profiles: List<Profile> = emptyList(),
)

@Serializable
data class GrantResult(val profiles: List<Profile> = emptyList())

@Serializable
data class LoginBody(val name: String, val password: String)
```

- [ ] **Step 2: Build (compiles)**

Run (from `apps/android-tv`, with JDK17 env): `./gradlew :app:assembleDebug -Porg.gradle.java.installations.paths=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 3: Commit**

```bash
git add apps/android-tv/app/src/main/java/network/luuk/horizontv/api/Models.kt
git commit -m "feat(androidtv): auth models (Profile, PairStartResult, AuthResult, GrantResult)"
```

---

### Task 2: HorizonApi — bearer token, X-Horizon-Profile, auth methods, Unauthorized

**Files:**
- Modify: `apps/android-tv/app/src/main/java/network/luuk/horizontv/api/HorizonApi.kt`
- Test: `apps/android-tv/app/src/test/java/network/luuk/horizontv/api/HorizonApiAuthTest.kt` (new)

- [ ] **Step 1: Write the failing test**

`apps/android-tv/app/src/test/java/network/luuk/horizontv/api/HorizonApiAuthTest.kt`:

```kotlin
package network.luuk.horizontv.api

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HorizonApiAuthTest {
    private fun api(server: MockWebServer): HorizonApi =
        HorizonApi(baseUrl = server.url("/").toString().trimEnd('/'))

    @Test fun `sends Bearer token and no X-Horizon-User`() = runBlocking {
        val server = MockWebServer(); server.enqueue(MockResponse().setBody("[]")); server.start()
        val a = api(server); a.setToken("tok-1")
        a.listMovies()
        val req = server.takeRequest()
        assertEquals("Bearer tok-1", req.getHeader("Authorization"))
        assertNull(req.getHeader("X-Horizon-User"))
        server.shutdown()
    }

    @Test fun `sends X-Horizon-Profile only when an active profile is set`() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("[]"))
        server.enqueue(MockResponse().setBody("[]"))
        server.start()
        val a = api(server); a.setToken("t")
        a.listMovies()
        assertNull(server.takeRequest().getHeader("X-Horizon-Profile"))
        a.setActiveProfile("p1")
        a.listMovies()
        assertEquals("p1", server.takeRequest().getHeader("X-Horizon-Profile"))
        server.shutdown()
    }

    @Test fun `maps 401 to Unauthorized`() = runBlocking {
        val server = MockWebServer(); server.enqueue(MockResponse().setResponseCode(401).setBody("""{"code":"unauthorized"}""")); server.start()
        val a = api(server); a.setToken("t")
        var threw = false
        try { a.listMovies() } catch (e: Unauthorized) { threw = true }
        assertTrue(threw)
        server.shutdown()
    }

    @Test fun `pairPoll returns Pending on 202 and Authed on 200`() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(202).setBody("""{"status":"pending"}"""))
        server.enqueue(MockResponse().setBody("""{"token":"tk","user":{"id":"u1","name":"A","createdAt":0,"updatedAt":0},"grant":["u1"],"profiles":[{"id":"u1","name":"A"}]}"""))
        server.start()
        val a = api(server)
        assertTrue(a.pairPoll("ABCD-1234") is PairPoll.Pending)
        val r = a.pairPoll("ABCD-1234")
        assertTrue(r is PairPoll.Authed && r.result.token == "tk")
        server.shutdown()
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :app:testDebugUnitTest --tests '*HorizonApiAuthTest' -Porg.gradle.java.installations.paths=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`
Expected: FAIL — `setToken`/`setActiveProfile`/`Unauthorized`/`pairPoll`/`PairPoll` don't exist.

- [ ] **Step 3: Implement**

In `api/HorizonApi.kt`:

Replace the `activeUserId` block + `setActiveUser`:

```kotlin
    @Volatile
    private var token: String? = null
    @Volatile
    private var activeProfileId: String? = null

    fun setToken(value: String?) { token = value }
    fun setActiveProfile(id: String?) { activeProfileId = id }
```

Remove the `// ----- users -----` methods (`listUsers`, `createUser`, `deleteUser`) — the picker uses granted profiles now.

Add an auth section (after the sessions block):

```kotlin
    // ----- auth -----
    suspend fun pairStart(): PairStartResult = postEmpty("/auth/pair/start", serializer())

    suspend fun pairPoll(code: String): PairPoll = withContext(Dispatchers.IO) {
        val payload = json.encodeToString(serializer(), PairPollBody(code))
        val req = Request.Builder().url(baseUrl + "/auth/pair/poll").post(payload.toRequestBody(jsonMedia))
        authHeaders(req)
        okHttp.newCall(req.build()).execute().use { resp ->
            val body = resp.body?.string().orEmpty()
            when {
                resp.code == 202 -> PairPoll.Pending
                resp.isSuccessful -> PairPoll.Authed(json.decodeFromString(AuthResult.serializer(), body))
                else -> {
                    val parsed = runCatching { json.decodeFromString(ErrorBody.serializer(), body) }.getOrNull()
                    throw ApiException(resp.code, parsed?.code, parsed?.error ?: "HTTP ${resp.code}")
                }
            }
        }
    }

    suspend fun login(name: String, password: String): AuthResult =
        post("/auth/login", LoginBody(name, password), serializer())

    suspend fun getGrant(): GrantResult = get("/auth/grant", serializer())
```

Add the `PairPoll` sealed type + `PairPollBody` at the bottom of the file (near `ApiException`):

```kotlin
@kotlinx.serialization.Serializable
data class PairPollBody(val code: String)

sealed interface PairPoll {
    data object Pending : PairPoll
    data class Authed(val result: AuthResult) : PairPoll
}
```

Add a `postEmpty` helper + an `authHeaders` helper, and update `exec()` to send the bearer + profile headers and map 401:

```kotlin
    private suspend fun <T> postEmpty(path: String, ser: KSerializer<T>): T =
        exec(Request.Builder().url(baseUrl + path).post(ByteArray(0).toRequestBody(jsonMedia)), ser)

    /** Apply auth headers to a request builder (bearer always when set; the
     *  active-profile selector only when one is chosen). */
    private fun authHeaders(req: Request.Builder) {
        token?.let { req.header("Authorization", "Bearer $it") }
        activeProfileId?.let { req.header("X-Horizon-Profile", it) }
    }
```

In `exec()`, replace the `val userId = activeUserId; if (userId != null) req.header("X-Horizon-User", userId)` lines with `authHeaders(req)`, and map 401 before the generic throw:

```kotlin
    private suspend fun <T> exec(req: Request.Builder, ser: KSerializer<T>): T =
        withContext(Dispatchers.IO) {
            authHeaders(req)
            okHttp.newCall(req.build()).execute().use { resp ->
                val body = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) {
                    val parsed = runCatching { json.decodeFromString(ErrorBody.serializer(), body) }.getOrNull()
                    if (resp.code == 401) throw Unauthorized(parsed?.code, parsed?.error ?: "Unauthorized")
                    throw ApiException(resp.code, parsed?.code, parsed?.error ?: "HTTP ${resp.code}")
                }
                if (ser.descriptor.serialName == "kotlin.Unit") {
                    @Suppress("UNCHECKED_CAST") return@withContext Unit as T
                }
                if (body.isEmpty()) throw ApiException(resp.code, "empty-body", "Empty response")
                json.decodeFromString(ser, body)
            }
        }
```

Add the `Unauthorized` exception below `ApiException`:

```kotlin
/** A 401 — the session token is missing/expired. Callers (AppState) drop the
 *  token and route back to AuthScreen rather than handling it per-screen. */
class Unauthorized(code: String?, message: String) : ApiException(401, code, message)
```

Make `ApiException` `open` so it can be subclassed (change `class ApiException` → `open class ApiException`). Ensure `ByteArray.toRequestBody` is imported (`import okhttp3.RequestBody.Companion.toRequestBody` already present).

Update the per-user methods so the path carries the active profile and the body matches — keep their `userId` parameters (callers pass the active profile id in Task 4/3); no signature change needed here.

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :app:testDebugUnitTest --tests '*HorizonApiAuthTest' -Porg.gradle.java.installations.paths=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/android-tv/app/src/main/java/network/luuk/horizontv/api/HorizonApi.kt apps/android-tv/app/src/test/java/network/luuk/horizontv/api/HorizonApiAuthTest.kt
git commit -m "feat(androidtv): HorizonApi bearer + X-Horizon-Profile + pairing/login/grant"
```

---

### Task 3: AppState — token, profiles, active profile

**Files:**
- Modify: `apps/android-tv/app/src/main/java/network/luuk/horizontv/app/AppState.kt`

**Context:** Replaces `activeUser` with token + granted `profiles` + `activeProfile`. Call sites that read `state.activeUser` (Library, Player, ProfileList) are updated in their own tasks; this task does the mechanical `state.activeUser?.id` → `state.activeProfile?.id` for files not otherwise touched, so the app keeps compiling.

- [ ] **Step 1: Implement**

Replace the `AppState` class body:

```kotlin
class AppState(
    val capabilities: Capabilities,
    val store: ServerStore,
    val mdns: MdnsDiscovery,
) {
    var api: HorizonApi? by mutableStateOf(null)
        private set
    var serverUrl: String? by mutableStateOf(null)
        private set

    /** Granted profiles for the current session (from pairing poll / /auth/grant). */
    var profiles: List<Profile> by mutableStateOf(emptyList())
        private set
    /** The profile the user is currently acting as (drives X-Horizon-Profile). */
    var activeProfile: Profile? by mutableStateOf(null)
        private set
    /** True once a session token is set on the api. */
    val isAuthenticated: Boolean get() = api?.let { token != null } ?: false

    private var token: String? = null

    fun connect(url: String) {
        serverUrl = url
        api = HorizonApi(baseUrl = url)
    }

    /** Apply a session token + its granted profiles to the connected api. */
    fun authenticate(sessionToken: String, granted: List<Profile>) {
        token = sessionToken
        api?.setToken(sessionToken)
        profiles = granted
    }

    fun setActiveProfile(profile: Profile?) {
        activeProfile = profile
        api?.setActiveProfile(profile?.id)
    }

    /** Drop the session (401 / sign-out): clears token, profiles, active profile. */
    fun signOut() {
        token = null
        profiles = emptyList()
        activeProfile = null
        api?.setToken(null)
        api?.setActiveProfile(null)
    }
}
```

Update imports: replace `import network.luuk.horizontv.api.User` with `import network.luuk.horizontv.api.Profile`. Update the KDoc lines that mention `activeUser` to describe `activeProfile`/`profiles`.

- [ ] **Step 2: Mechanical call-site fix for non-screen references**

Grep for remaining `activeUser` and fix any outside the screens edited later:

```bash
grep -rn "activeUser\|setActiveUser" apps/android-tv/app/src/main/java
```

Player/Library/ProfileList are handled in Tasks 6/7/8; if any other reference exists, change `state.activeUser?.id` → `state.activeProfile?.id`. (Expect only the three screens.)

- [ ] **Step 3: Commit (build happens after the screens are updated in Task 8)**

```bash
git add apps/android-tv/app/src/main/java/network/luuk/horizontv/app/AppState.kt
git commit -m "feat(androidtv): AppState session token + granted profiles + active profile"
```

> The project will not fully compile until the screens (Tasks 6–8) are updated; that's expected for this slice. The next tasks restore green.

---

### Task 4: ServerStore — persist the session token

**Files:**
- Modify: `apps/android-tv/app/src/main/java/network/luuk/horizontv/discovery/ServerStore.kt`
- Test: `apps/android-tv/app/src/test/java/network/luuk/horizontv/discovery/ServerStoreTest.kt`

- [ ] **Step 1: Write the failing test**

Append to `ServerStoreTest.kt`:

```kotlin
    @Test fun `saveToken then readToken round-trips; clearToken removes it`() = runBlocking {
        assertNull(store.readToken())
        store.saveToken("tok-9")
        assertEquals("tok-9", store.readToken())
        store.clearToken()
        assertNull(store.readToken())
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :app:testDebugUnitTest --tests '*ServerStoreTest' -Porg.gradle.java.installations.paths=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`
Expected: FAIL — `saveToken`/`readToken`/`clearToken` missing.

- [ ] **Step 3: Implement**

In `ServerStore.kt`, add a token key + accessors:

```kotlin
    private val tokenKey = stringPreferencesKey("session_token")

    suspend fun readToken(): String? = store.data.first()[tokenKey]

    suspend fun saveToken(token: String) {
        store.edit { it[tokenKey] = token }
    }

    suspend fun clearToken() {
        store.edit { it.remove(tokenKey) }
    }
```

> The token rides the same DataStore as the saved server, so it's naturally scoped to this install. Switching servers (Task 8 "Switch server") should `clearToken()` so a stale token isn't presented to a different server.

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :app:testDebugUnitTest --tests '*ServerStoreTest' -Porg.gradle.java.installations.paths=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/android-tv/app/src/main/java/network/luuk/horizontv/discovery/ServerStore.kt apps/android-tv/app/src/test/java/network/luuk/horizontv/discovery/ServerStoreTest.kt
git commit -m "feat(androidtv): persist session token in ServerStore"
```

---

# Phase 2 — Auth flow & screens

### Task 5: Auth decision (pure logic)

**Files:**
- Create: `apps/android-tv/app/src/main/java/network/luuk/horizontv/discovery/AuthResolver.kt`
- Test: `apps/android-tv/app/src/test/java/network/luuk/horizontv/discovery/AuthResolverTest.kt`

**Context:** After the server is connected, decide whether the saved token still authenticates (and yields the granted profiles) or the TV must re-auth. Pure over an injected `fetchGrant` that returns the granted profiles or throws `Unauthorized`/null.

- [ ] **Step 1: Write the failing test**

`apps/android-tv/app/src/test/java/network/luuk/horizontv/discovery/AuthResolverTest.kt`:

```kotlin
package network.luuk.horizontv.discovery

import kotlinx.coroutines.runBlocking
import network.luuk.horizontv.api.Profile
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AuthResolverTest {
    @Test fun `no saved token needs auth`() = runBlocking {
        val d = resolveAuth(savedToken = null, fetchGrant = { error("not called") })
        assertTrue(d is AuthDecision.NeedAuth)
    }

    @Test fun `valid token yields the granted profiles`() = runBlocking {
        val profiles = listOf(Profile("u1", "A"), Profile("u2", "B"))
        val d = resolveAuth(savedToken = "t", fetchGrant = { profiles })
        assertEquals(AuthDecision.Authed("t", profiles), d)
    }

    @Test fun `token rejected (fetchGrant returns null) needs auth`() = runBlocking {
        val d = resolveAuth(savedToken = "t", fetchGrant = { null })
        assertTrue(d is AuthDecision.NeedAuth)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./gradlew :app:testDebugUnitTest --tests '*AuthResolverTest' -Porg.gradle.java.installations.paths=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`
Expected: FAIL — symbols unresolved.

- [ ] **Step 3: Implement**

`apps/android-tv/app/src/main/java/network/luuk/horizontv/discovery/AuthResolver.kt`:

```kotlin
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./gradlew :app:testDebugUnitTest --tests '*AuthResolverTest' -Porg.gradle.java.installations.paths=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/android-tv/app/src/main/java/network/luuk/horizontv/discovery/AuthResolver.kt apps/android-tv/app/src/test/java/network/luuk/horizontv/discovery/AuthResolverTest.kt
git commit -m "feat(androidtv): pure post-connect auth decision"
```

---

### Task 6: BootScreen — validate token after connect

**Files:**
- Modify: `apps/android-tv/app/src/main/java/network/luuk/horizontv/ui/BootScreen.kt`

**Context:** Today BootScreen's `onConnected` goes to the profile list. Now, after `connect`, it must validate any saved token and route to the picker (authed) or AuthScreen. Add an `onNeedAuth` callback and an `onAuthed` callback (replacing `onConnected`).

- [ ] **Step 1: Implement**

In `BootScreen.kt`, change the signature and the post-connect block:

```kotlin
@Composable
fun BootScreen(onAuthed: () -> Unit, onNeedAuth: () -> Unit, onNeedPicker: () -> Unit) {
    val state = LocalAppState.current

    LaunchedEffect(Unit) {
        val saved = state.store.read()
        val client = OkHttpClient.Builder()
            .connectTimeout(2, TimeUnit.SECONDS)
            .readTimeout(2, TimeUnit.SECONDS)
            .build()

        val decision = resolveBoot(
            saved = saved,
            probe = { url ->
                network.luuk.horizontv.discovery.probeHealth(
                    client, url, network.luuk.horizontv.discovery.Source.Manual,
                )?.instanceId
            },
            mdnsFind = { wantedId ->
                withTimeoutOrNull(4_000) {
                    state.mdns.discover()
                        .mapNotNull { if (it.instanceId == wantedId) it.url else null }
                        .first()
                }
            },
        )

        when (decision) {
            is BootDecision.Connect -> {
                state.connect(decision.url)
                if (saved == null || saved.lastUrl != decision.url) {
                    state.store.save(
                        network.luuk.horizontv.discovery.SavedServer(
                            decision.instanceId, decision.url, decision.name,
                        )
                    )
                }
                // Now decide auth: validate any saved token via /auth/grant.
                val authDecision = network.luuk.horizontv.discovery.resolveAuth(
                    savedToken = state.store.readToken(),
                    fetchGrant = { _ ->
                        // The token was just saved into the api by authenticate()? No —
                        // set it provisionally so the grant call carries it.
                        state.api!!.setToken(state.store.readToken())
                        try { state.api!!.getGrant().profiles }
                        catch (_: Throwable) { null }
                    },
                )
                when (authDecision) {
                    is network.luuk.horizontv.discovery.AuthDecision.Authed -> {
                        state.authenticate(authDecision.token, authDecision.profiles)
                        onAuthed()
                    }
                    network.luuk.horizontv.discovery.AuthDecision.NeedAuth -> {
                        state.store.clearToken()
                        state.api!!.setToken(null)
                        onNeedAuth()
                    }
                }
            }
            BootDecision.ShowPicker -> onNeedPicker()
        }
    }

    Box(Modifier.fillMaxSize()) { Text("Horizon", Modifier.align(Alignment.Center)) }
}
```

- [ ] **Step 2: (build verified at Task 8 once screens + nav exist)**

- [ ] **Step 3: Commit**

```bash
git add apps/android-tv/app/src/main/java/network/luuk/horizontv/ui/BootScreen.kt
git commit -m "feat(androidtv): boot validates saved token via /auth/grant"
```

---

### Task 7: AuthScreen — pairing + password fallback

**Files:**
- Create: `apps/android-tv/app/src/main/java/network/luuk/horizontv/ui/AuthScreen.kt`

- [ ] **Step 1: Implement**

`apps/android-tv/app/src/main/java/network/luuk/horizontv/ui/AuthScreen.kt`:

```kotlin
package network.luuk.horizontv.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import network.luuk.horizontv.api.ApiException
import network.luuk.horizontv.api.PairPoll
import network.luuk.horizontv.app.LocalAppState

private enum class Mode { Pairing, Password }

@Composable
fun AuthScreen(onAuthed: () -> Unit) {
    val state = LocalAppState.current
    val api = state.api!!
    var mode by remember { mutableStateOf(Mode.Pairing) }

    Column(
        Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (mode == Mode.Pairing) {
            PairingView(onAuthed = onAuthed, onPassword = { mode = Mode.Password })
        } else {
            PasswordView(onAuthed = onAuthed, onPairing = { mode = Mode.Pairing })
        }
    }
}

@Composable
private fun PairingView(onAuthed: () -> Unit, onPassword: () -> Unit) {
    val state = LocalAppState.current
    val api = state.api!!
    var code by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    // Start a code + poll loop; re-mints on expiry. Cancelled on leaving the view.
    DisposableEffect(Unit) {
        val job = kotlinx.coroutines.MainScope().launch {
            while (isActive) {
                try {
                    val started = api.pairStart()
                    code = started.code
                    error = null
                    // Poll this code until approved or expired.
                    pollLoop@ while (isActive) {
                        delay(3_000)
                        when (val r = runCatching { api.pairPoll(started.code) }.getOrElse { e ->
                            if (e is ApiException && e.status == 410) break@pollLoop // expired → re-mint
                            error = "Couldn’t reach the server."; delay(2_000); null
                        }) {
                            is PairPoll.Authed -> {
                                state.authenticate(r.result.token, r.result.profiles)
                                state.store.saveToken(r.result.token)
                                onAuthed(); return@launch
                            }
                            PairPoll.Pending, null -> { /* keep polling */ }
                        }
                    }
                } catch (_: Throwable) {
                    error = "Couldn’t reach the server."
                    delay(3_000)
                }
            }
        }
        onDispose { job.cancel() }
    }

    Text("Link this TV")
    Text(code ?: "…", Modifier.padding(8.dp))
    Text("On your phone: Horizon → Settings → Household → Link a TV, then enter this code.")
    if (error != null) Text(error!!)
    TextButton(onClick = onPassword) { Text("Enter password instead") }
}

@Composable
private fun PasswordView(onAuthed: () -> Unit, onPairing: () -> Unit) {
    val state = LocalAppState.current
    val api = state.api!!
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    Text("Sign in")
    OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("Name") })
    OutlinedTextField(value = password, onValueChange = { password = it }, label = { Text("Password") })
    if (error != null) Text(error!!)
    Button(enabled = !busy, onClick = {
        busy = true; error = null
        scope.launch {
            try {
                val res = api.login(name.trim(), password)
                api.setToken(res.token)
                val profiles = runCatching { api.getGrant().profiles }.getOrDefault(emptyList())
                state.authenticate(res.token, profiles.ifEmpty { listOf(network.luuk.horizontv.api.Profile(res.user.id, res.user.name, res.user.avatar)) })
                state.store.saveToken(res.token)
                onAuthed()
            } catch (e: ApiException) {
                error = when (e.code) {
                    "invalid-credentials" -> "Wrong name or password."
                    "account-locked" -> "Account temporarily locked."
                    "rate-limited" -> "Too many attempts — wait a moment."
                    else -> e.message
                }
            } finally { busy = false }
        }
    }) { Text("Sign in") }
    TextButton(onClick = onPairing) { Text("Use a code instead") }
}
```

> The pairing loop uses a `MainScope` job cancelled in `onDispose` — matching the discovery `ProgressSocket`/scan lifecycle discipline (no leaked polling).

- [ ] **Step 2: (build verified at Task 8)**

- [ ] **Step 3: Commit**

```bash
git add apps/android-tv/app/src/main/java/network/luuk/horizontv/ui/AuthScreen.kt
git commit -m "feat(androidtv): AuthScreen — pairing + password fallback"
```

---

### Task 8: Profile picker rework + Library/Player active-profile + nav

**Files:**
- Modify: `ui/ProfileListScreen.kt`, `ui/LibraryScreen.kt`, `ui/PlayerScreen.kt`, `ui/Routes.kt`, `MainActivity.kt`

- [ ] **Step 1: Rework ProfileListScreen into a granted-profile picker**

Replace `ProfileListScreen.kt` body — render `state.profiles`, no add/delete, add switch-server (clears token) + sign-out:

```kotlin
package network.luuk.horizontv.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.tv.material3.ListItem
import kotlinx.coroutines.launch
import network.luuk.horizontv.app.LocalAppState

@Composable
fun ProfileListScreen(
    onProfilePicked: () -> Unit,
    onSwitchServer: () -> Unit,
    onSignOut: () -> Unit,
) {
    val state = LocalAppState.current
    val scope = rememberCoroutineScope()
    val profiles = state.profiles

    Column(
        Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Who's watching?")
        LazyColumn(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            items(profiles, key = { it.id }) { p ->
                ListItem(
                    selected = false,
                    onClick = { state.setActiveProfile(p); onProfilePicked() },
                    headlineContent = { Text(p.name) },
                )
            }
            item(key = "switch_server") {
                ListItem(
                    selected = false,
                    onClick = { scope.launch { state.store.clearToken(); onSwitchServer() } },
                    headlineContent = { Text("Switch server") },
                )
            }
            item(key = "sign_out") {
                ListItem(
                    selected = false,
                    onClick = { scope.launch { state.store.clearToken(); state.signOut(); onSignOut() } },
                    headlineContent = { Text("Sign out this TV") },
                )
            }
        }
    }
}
```

- [ ] **Step 2: Library/Player use the active profile**

In `LibraryScreen.kt` and `PlayerScreen.kt`, replace `state.activeUser?.id` / `state.activeUser!!.id` with `state.activeProfile?.id` / `state.activeProfile!!.id` (continue-watching, getProgress, createSession `userId`). Grep to find them:

```bash
grep -rn "activeUser" apps/android-tv/app/src/main/java/network/luuk/horizontv/ui
```

Replace each occurrence accordingly (the `?.id`/`!!.id` access shape is unchanged — only `activeUser` → `activeProfile`).

- [ ] **Step 3: Routes + MainActivity nav**

In `Routes.kt` add:

```kotlin
    const val AUTH = "auth"
```

In `MainActivity.kt`:
- BootScreen composable: pass the three callbacks:

```kotlin
                    composable(Routes.BOOT) {
                        BootScreen(
                            onAuthed = { nav.navigate(Routes.PROFILE_LIST) { popUpTo(Routes.BOOT) { inclusive = true } } },
                            onNeedAuth = { nav.navigate(Routes.AUTH) { popUpTo(Routes.BOOT) { inclusive = true } } },
                            onNeedPicker = { nav.navigate(Routes.SERVER_PICKER) { popUpTo(Routes.BOOT) { inclusive = true } } },
                        )
                    }
                    composable(Routes.AUTH) {
                        if (state.api == null) { LaunchedEffect(Unit) { nav.navigate(Routes.BOOT) { popUpTo(0) { inclusive = true } } }; return@composable }
                        AuthScreen(onAuthed = { nav.navigate(Routes.PROFILE_LIST) { popUpTo(Routes.AUTH) { inclusive = true } } })
                    }
```

- ServerPicker's `onPicked`: after connecting to a (possibly different) server, route to AUTH (not PROFILE_LIST) since the new server needs its own session:

```kotlin
                    composable(Routes.SERVER_PICKER) {
                        ServerPickerScreen(onPicked = {
                            nav.navigate(Routes.AUTH) { popUpTo(Routes.SERVER_PICKER) { inclusive = true } }
                        })
                    }
```

- PROFILE_LIST composable: update to the new `ProfileListScreen` signature + guard:

```kotlin
                    composable(Routes.PROFILE_LIST) {
                        if (!connectedGuard(state, nav)) return@composable
                        ProfileListScreen(
                            onProfilePicked = { nav.navigate(Routes.LIBRARY) { popUpTo(Routes.PROFILE_LIST) { inclusive = true } } },
                            onSwitchServer = { nav.navigate(Routes.SERVER_PICKER) },
                            onSignOut = { nav.navigate(Routes.AUTH) { popUpTo(Routes.PROFILE_LIST) { inclusive = true } } },
                        )
                    }
```

> `connectedGuard` already exists (from discovery). Keep the existing LIBRARY/SHOW_DETAIL/PLAYER composables; their `connectedGuard` stays. (The api being non-null implies connected; an unauthenticated api still has no token, but those screens are only reached after a profile pick, i.e. post-auth.)

- [ ] **Step 4: Build + run all unit tests**

Run: `./gradlew :app:testDebugUnitTest assembleDebug -Porg.gradle.java.installations.paths=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`
Expected: BUILD SUCCESSFUL; tests pass (HorizonApiAuthTest, AuthResolverTest, ServerStoreTest, plus the pre-existing discovery suite).

- [ ] **Step 5: Commit**

```bash
git add apps/android-tv/app/src/main/java/network/luuk/horizontv/ui apps/android-tv/app/src/main/java/network/luuk/horizontv/MainActivity.kt
git commit -m "feat(androidtv): granted-profile picker, active-profile playback, auth nav"
```

---

## Final verification

- [ ] From `apps/android-tv` with the JDK17 env: `./gradlew :app:testDebugUnitTest assembleDebug -Porg.gradle.java.installations.paths=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home` → BUILD SUCCESSFUL, all unit tests pass.
- [ ] `grep -rn "X-Horizon-User\|activeUser\|listUsers\|createUser\|deleteUser" apps/android-tv/app/src/main/java` → no matches (legacy auth + user-CRUD fully removed).
- [ ] On-device (manual, documented — not automated): pair the TV (code → approve on web with a profile grant → TV lands on the granted picker → play); kill + relaunch → straight to the picker (token persisted); "Sign out this TV" → back to pairing; password fallback signs in a single profile.

## Notes for the implementer

- AppState briefly breaks compilation between Task 3 and Task 8 (screens still reference `activeUser`); Task 8 restores green. Subagent-driven execution should treat Tasks 3 + 6 + 7 + 8 as the slice that must build together — if running task-by-task, the build step lives at Task 8.
- Keep the pairing poll loop cancellation strict (DisposableEffect onDispose) — a leaked 3s poll against a dead session is the main lifecycle risk.
- The server's `/auth/grant` returns `{ profiles }`; a 401/throw there means the token is stale → boot routes to AuthScreen.
- **Mid-session 401 scope:** this plan handles 401 at **boot** (stale token → AuthScreen) and exposes a typed `Unauthorized`. A token expiring *while browsing* surfaces as a screen-level error (existing try/catch) and is fully resolved on next launch (sessions are 90-day sliding, so mid-session expiry is rare). A global `Unauthorized → signOut → AuthScreen` interceptor is a deliberate follow-up, not in this plan — call it out at review if you want it included now (it needs a nav-from-non-composable channel, e.g. an AppState event the NavHost observes).
