# Android TV Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Jetpack Compose for TV app at `tv/` in the Horizon monorepo that runs on Shield Pro and any ATV / Google TV box down to Android 6, talks to the existing Horizon server, and plays 4K HDR/DV content via Media3 — no visual styling.

**Architecture:** Single-activity Compose app. `NavHost` routes between Profile → Library → ShowDetail → Player. A thin `HorizonApi` layer over OkHttp talks to the unchanged Fastify server. A one-shot `CapabilitiesProbe` turns the real device's `MediaCodecList` + `Display.HdrCapabilities` + `AudioDeviceInfo` into the caps body the server expects. All state held in a simple `AppState` singleton (manual DI, no Hilt).

**Tech Stack:** Kotlin 2.1 (K2), AGP 8.7, Compose BOM 2025.01, `androidx.tv:tv-material` 1.0.0, Media3 1.5.1, Coil 3.0.x, OkHttp 5.0.x, kotlinx.serialization 1.7.x, minSdk 23 / targetSdk 35, JDK 17 toolchain.

---

## Task checklist overview

1. Gradle project scaffold + version catalog
2. AndroidManifest + `res/` (banner, icon, network config, strings, theme)
3. API models (kotlinx.serialization types matching server)
4. API client (OkHttp + typed endpoints)
5. Capabilities probe + MIME/HDR/audio-encoding mapping tables
6. App state + Application class + BuildConfig wiring
7. MainActivity + NavHost + route registry
8. Profile list screen
9. Library screen (tabs + Continue Watching rail + grid)
10. Show detail screen
11. Progress WebSocket reporter
12. Player screen (Media3 + resume toast)
13. Root-repo glue: `.gitignore`, `README.md` snippet, deploy helper

Each task ends with a commit. Tasks 3 / 5 have real JVM unit tests; UI tasks verify with `./gradlew :app:assembleDebug` (compile + lint).

---

### Task 1: Gradle scaffold + version catalog

**Files:**
- Create: `tv/settings.gradle.kts`
- Create: `tv/build.gradle.kts`
- Create: `tv/gradle.properties`
- Create: `tv/gradle/libs.versions.toml`
- Create: `tv/gradle/wrapper/gradle-wrapper.properties`
- Create: `tv/gradlew` (wrapper script; copy from `./gradle wrapper` output)
- Create: `tv/local.properties.example`
- Modify: `.gitignore` (add TV build artifacts)

- [ ] **Step 1: Create version catalog**

Create `tv/gradle/libs.versions.toml`:

```toml
[versions]
agp = "8.7.3"
kotlin = "2.1.0"
ksp = "2.1.0-1.0.29"
coroutines = "1.9.0"
serialization = "1.7.3"
okhttp = "5.0.0-alpha.14"
coil = "3.0.4"
media3 = "1.5.1"
composeBom = "2025.01.00"
composeCompiler = "1.5.15"
tvMaterial = "1.0.0"
activityCompose = "1.9.3"
navigationCompose = "2.8.5"
lifecycle = "2.8.7"
androidxCore = "1.15.0"
junit = "4.13.2"

[libraries]
kotlin-serialization-json = { module = "org.jetbrains.kotlinx:kotlinx-serialization-json", version.ref = "serialization" }
coroutines-core = { module = "org.jetbrains.kotlinx:kotlinx-coroutines-core", version.ref = "coroutines" }
coroutines-android = { module = "org.jetbrains.kotlinx:kotlinx-coroutines-android", version.ref = "coroutines" }
okhttp = { module = "com.squareup.okhttp3:okhttp", version.ref = "okhttp" }
okhttp-logging = { module = "com.squareup.okhttp3:logging-interceptor", version.ref = "okhttp" }

androidx-core = { module = "androidx.core:core-ktx", version.ref = "androidxCore" }
androidx-activity-compose = { module = "androidx.activity:activity-compose", version.ref = "activityCompose" }
androidx-lifecycle-runtime = { module = "androidx.lifecycle:lifecycle-runtime-ktx", version.ref = "lifecycle" }
androidx-lifecycle-viewmodel-compose = { module = "androidx.lifecycle:lifecycle-viewmodel-compose", version.ref = "lifecycle" }
androidx-navigation-compose = { module = "androidx.navigation:navigation-compose", version.ref = "navigationCompose" }

compose-bom = { module = "androidx.compose:compose-bom", version.ref = "composeBom" }
compose-ui = { module = "androidx.compose.ui:ui" }
compose-ui-tooling = { module = "androidx.compose.ui:ui-tooling" }
compose-ui-tooling-preview = { module = "androidx.compose.ui:ui-tooling-preview" }
compose-foundation = { module = "androidx.compose.foundation:foundation" }
compose-material3 = { module = "androidx.compose.material3:material3" }

tv-material = { module = "androidx.tv:tv-material", version.ref = "tvMaterial" }

media3-exoplayer = { module = "androidx.media3:media3-exoplayer", version.ref = "media3" }
media3-exoplayer-hls = { module = "androidx.media3:media3-exoplayer-hls", version.ref = "media3" }
media3-ui = { module = "androidx.media3:media3-ui", version.ref = "media3" }
media3-common = { module = "androidx.media3:media3-common", version.ref = "media3" }
media3-datasource-okhttp = { module = "androidx.media3:media3-datasource-okhttp", version.ref = "media3" }

coil-compose = { module = "io.coil-kt.coil3:coil-compose", version.ref = "coil" }
coil-network-okhttp = { module = "io.coil-kt.coil3:coil-network-okhttp", version.ref = "coil" }

junit = { module = "junit:junit", version.ref = "junit" }

[plugins]
android-application = { id = "com.android.application", version.ref = "agp" }
kotlin-android = { id = "org.jetbrains.kotlin.android", version.ref = "kotlin" }
kotlin-serialization = { id = "org.jetbrains.kotlin.plugin.serialization", version.ref = "kotlin" }
compose-compiler = { id = "org.jetbrains.kotlin.plugin.compose", version.ref = "kotlin" }
```

- [ ] **Step 2: Create settings.gradle.kts**

Create `tv/settings.gradle.kts`:

```kotlin
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "Horizon"
include(":app")
```

- [ ] **Step 3: Create top-level build.gradle.kts**

Create `tv/build.gradle.kts`:

```kotlin
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.compose.compiler) apply false
}
```

- [ ] **Step 4: Create gradle.properties**

Create `tv/gradle.properties`:

```
org.gradle.jvmargs=-Xmx4g -Dfile.encoding=UTF-8
org.gradle.parallel=true
org.gradle.caching=true
android.useAndroidX=true
android.nonTransitiveRClass=true
android.enableR8.fullMode=true
kotlin.code.style=official
```

- [ ] **Step 5: Create Gradle wrapper**

Run from repo root:

```bash
mkdir -p tv/gradle/wrapper
cd tv && gradle wrapper --gradle-version 8.11.1 --distribution-type all
```

Expected: creates `tv/gradlew`, `tv/gradlew.bat`, `tv/gradle/wrapper/gradle-wrapper.jar`, `tv/gradle/wrapper/gradle-wrapper.properties`. (If the host has no system Gradle, run `brew install gradle` or use any other project's wrapper as a bootstrap.)

- [ ] **Step 6: Create local.properties example**

Create `tv/local.properties.example`:

```
sdk.dir=/Users/luuk/Library/Android/sdk
HORIZON_SERVER_URL=http://192.168.1.10:7777
```

- [ ] **Step 7: Update root .gitignore**

Append to `/Users/luuk/Projects/slimluccii/horizon/.gitignore`:

```
# Android TV client build artifacts
tv/.gradle/
tv/.idea/
tv/build/
tv/app/build/
tv/local.properties
tv/captures/
tv/*.iml
tv/app/*.iml
```

- [ ] **Step 8: Verify Gradle parses**

Run from `tv/`:

```bash
./gradlew --version
```

Expected: prints Gradle 8.11.x, Kotlin 2.1.0, JVM 17. Does not report missing plugins (they're `apply false` at root).

- [ ] **Step 9: Commit**

```bash
git add tv/settings.gradle.kts tv/build.gradle.kts tv/gradle.properties \
  tv/gradle/libs.versions.toml tv/gradle/wrapper/ tv/gradlew tv/gradlew.bat \
  tv/local.properties.example .gitignore
git commit -m "feat(tv): Gradle scaffold + version catalog for Android TV client"
```

---

### Task 2: `:app` module + AndroidManifest + resources

**Files:**
- Create: `tv/app/build.gradle.kts`
- Create: `tv/app/proguard-rules.pro`
- Create: `tv/app/src/main/AndroidManifest.xml`
- Create: `tv/app/src/main/res/xml/network_security_config.xml`
- Create: `tv/app/src/main/res/drawable/banner.xml`
- Create: `tv/app/src/main/res/values/strings.xml`
- Create: `tv/app/src/main/res/values/themes.xml`
- Create: `tv/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml`
- Create: `tv/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml`
- Create: `tv/app/src/main/res/drawable/ic_launcher_foreground.xml`
- Create: `tv/app/src/main/res/values/ic_launcher_background.xml`

- [ ] **Step 1: Write `app/build.gradle.kts`**

Create `tv/app/build.gradle.kts`:

```kotlin
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.compose.compiler)
}

// Read HORIZON_SERVER_URL from local.properties so devs don't commit IPs.
val serverUrl: String = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}.getProperty("HORIZON_SERVER_URL", "http://10.0.2.2:7777")

android {
    namespace = "network.luuk.horizontv"
    compileSdk = 35

    defaultConfig {
        applicationId = "network.luuk.horizontv"
        minSdk = 23
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        buildConfigField("String", "SERVER_URL", "\"$serverUrl\"")
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a") }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlin { jvmToolchain(17) }

    buildTypes {
        debug { isMinifyEnabled = false }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    packaging {
        resources.excludes += listOf(
            "/META-INF/{AL2.0,LGPL2.1}",
            "/META-INF/DEPENDENCIES",
        )
    }
}

dependencies {
    implementation(libs.androidx.core)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.navigation.compose)

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.compose.ui.tooling.preview)
    debugImplementation(libs.compose.ui.tooling)

    implementation(libs.tv.material)

    implementation(libs.media3.exoplayer)
    implementation(libs.media3.exoplayer.hls)
    implementation(libs.media3.ui)
    implementation(libs.media3.common)
    implementation(libs.media3.datasource.okhttp)

    implementation(libs.okhttp)
    implementation(libs.okhttp.logging)
    implementation(libs.kotlin.serialization.json)
    implementation(libs.coroutines.core)
    implementation(libs.coroutines.android)

    implementation(libs.coil.compose)
    implementation(libs.coil.network.okhttp)

    testImplementation(libs.junit)
    testImplementation(libs.kotlin.serialization.json)
}
```

- [ ] **Step 2: Write proguard-rules.pro**

Create `tv/app/proguard-rules.pro`:

```
# kotlinx.serialization keeps its own metadata — no rules needed in 1.6+.
# Media3 + Compose + OkHttp ship consumer rules. Keep this file minimal.

# Our serializable models live in api/Models.kt — keep their companions so
# kotlinx-serialization can find the generated serializers via reflection.
-keep class network.luuk.horizontv.api.** { *; }
-keepclassmembers class network.luuk.horizontv.api.** {
    public static ** Companion;
}
```

- [ ] **Step 3: Write AndroidManifest.xml**

Create `tv/app/src/main/AndroidManifest.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:tools="http://schemas.android.com/tools">

    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />

    <uses-feature android:name="android.software.leanback" android:required="true" />
    <uses-feature android:name="android.hardware.touchscreen" android:required="false" />

    <application
        android:name=".HorizonApp"
        android:allowBackup="false"
        android:banner="@drawable/banner"
        android:icon="@mipmap/ic_launcher"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:label="@string/app_name"
        android:theme="@style/Theme.Horizon"
        android:networkSecurityConfig="@xml/network_security_config"
        android:isGame="false"
        tools:targetApi="34">

        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:launchMode="singleTop"
            android:screenOrientation="landscape"
            android:resizeableActivity="false"
            android:configChanges="keyboard|keyboardHidden|orientation|screenSize|uiMode">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LEANBACK_LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
```

- [ ] **Step 4: Write network_security_config.xml**

Create `tv/app/src/main/res/xml/network_security_config.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </base-config>
</network-security-config>
```

- [ ] **Step 5: Write placeholder banner**

Create `tv/app/src/main/res/drawable/banner.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="320dp"
    android:height="180dp"
    android:viewportWidth="320"
    android:viewportHeight="180">
    <path android:fillColor="#0F172A"
        android:pathData="M0,0h320v180h-320z" />
    <path android:fillColor="#60A5FA"
        android:pathData="M40,90h240M160,40v100"
        android:strokeWidth="6"
        android:strokeColor="#60A5FA"
        android:strokeLineCap="round" />
</vector>
```

- [ ] **Step 6: Write strings + theme + launcher icon**

Create `tv/app/src/main/res/values/strings.xml`:

```xml
<resources>
    <string name="app_name">Horizon</string>
</resources>
```

Create `tv/app/src/main/res/values/themes.xml`:

```xml
<resources>
    <style name="Theme.Horizon" parent="android:Theme.Material.NoActionBar" />
</resources>
```

Create `tv/app/src/main/res/values/ic_launcher_background.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#0F172A</color>
</resources>
```

Create `tv/app/src/main/res/drawable/ic_launcher_foreground.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path android:fillColor="#60A5FA"
        android:pathData="M34,54h40M54,34v40"
        android:strokeColor="#60A5FA"
        android:strokeWidth="6"
        android:strokeLineCap="round" />
</vector>
```

Create `tv/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
```

Create `tv/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
```

- [ ] **Step 7: Add a stub MainActivity + Application so the module compiles**

Create `tv/app/src/main/java/network/luuk/horizontv/HorizonApp.kt`:

```kotlin
package network.luuk.horizontv

import android.app.Application

class HorizonApp : Application()
```

Create `tv/app/src/main/java/network/luuk/horizontv/MainActivity.kt`:

```kotlin
package network.luuk.horizontv

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.Text

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { Text("Horizon") }
    }
}
```

- [ ] **Step 8: Build the debug APK**

Run from `tv/`:

```bash
./gradlew :app:assembleDebug
```

Expected: `BUILD SUCCESSFUL` in <90 s on a warm machine. APK at `tv/app/build/outputs/apk/debug/app-debug.apk`.

- [ ] **Step 9: Commit**

```bash
git add tv/app/
git commit -m "feat(tv): :app module with manifest, resources, stub entry point"
```

---

### Task 3: API models (kotlinx.serialization)

**Files:**
- Create: `tv/app/src/main/java/network/luuk/horizontv/api/Models.kt`
- Create: `tv/app/src/test/java/network/luuk/horizontv/api/ModelsTest.kt`

- [ ] **Step 1: Write the failing test for `User` decode**

Create `tv/app/src/test/java/network/luuk/horizontv/api/ModelsTest.kt`:

```kotlin
package network.luuk.horizontv.api

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ModelsTest {
    private val json = Json { ignoreUnknownKeys = true }

    @Test fun `user decodes from real server payload`() {
        val raw = """
            {"id":"u1","name":"Luuk","avatar":null,
             "preferences":{},"createdAt":1,"updatedAt":2}
        """.trimIndent()
        val u = json.decodeFromString(User.serializer(), raw)
        assertEquals("u1", u.id)
        assertEquals("Luuk", u.name)
        assertNull(u.avatar)
    }
}
```

- [ ] **Step 2: Run the test and watch it fail**

Run:

```bash
cd tv && ./gradlew :app:testDebugUnitTest --tests '*ModelsTest*'
```

Expected: FAIL — `Unresolved reference: User`.

- [ ] **Step 3: Write `Models.kt` with every type we'll need**

Create `tv/app/src/main/java/network/luuk/horizontv/api/Models.kt`:

```kotlin
package network.luuk.horizontv.api

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

// ---------- users -----------------------------------------------------------

@Serializable
data class User(
    val id: String,
    val name: String,
    val avatar: String? = null,
    val preferences: Map<String, JsonElement> = emptyMap(),
    val createdAt: Long,
    val updatedAt: Long,
)

@Serializable
data class CreateUserBody(val name: String, val avatar: String? = null)

// ---------- media -----------------------------------------------------------

@Serializable
data class HdrFlags(
    val dv: Boolean = false,
    val hdr10: Boolean = false,
    val hdr10plus: Boolean = false,
    val dvProfile: Int? = null,
)

@Serializable
data class AudioTrack(
    val index: Int,
    val codec: String,
    val channels: Int,
    val language: String,
    val title: String,
    @SerialName("default") val isDefault: Boolean = false,
)

@Serializable
data class SubtitleTrack(
    val index: Int,
    val codec: String,
    val language: String,
    val forced: Boolean = false,
    val embeddable: Boolean = false,
)

@Serializable
data class ExternalIds(val tmdb: Int? = null, val tvdb: Int? = null, val imdb: String? = null)

@Serializable
data class LooseMetadata(
    val title: String? = null,
    val tagline: String? = null,
    val overview: String? = null,
    val releaseDate: String? = null,
    val firstAirDate: String? = null,
    val airDate: String? = null,
    val rating: Double? = null,
    val ratingCount: Int? = null,
    val runtimeMinutes: Int? = null,
    val genres: List<String>? = null,
    val posterPath: String? = null,
    val backdropPath: String? = null,
    val stillPath: String? = null,
    val network: String? = null,
    val status: String? = null,
    val tmdbId: Int? = null,
)

@Serializable
data class MediaItem(
    val id: String,
    val kind: String,
    val title: String,
    val parentId: String? = null,
    val sortYear: Int? = null,
    val season: Int? = null,
    val episode: Int? = null,
    val durationSec: Double? = null,
    val resolution: String? = null,
    val videoCodec: String? = null,
    val container: String? = null,
    val hdr: HdrFlags? = null,
    val audioTracks: List<AudioTrack>? = null,
    val subtitleTracks: List<SubtitleTrack>? = null,
    val externalIds: ExternalIds? = null,
    val metadata: LooseMetadata? = null,
)

@Serializable
data class SeasonSummary(val number: Int, val episodeCount: Int)

@Serializable
data class ShowSummary(
    val id: String,
    val title: String,
    val seasons: List<SeasonSummary>,
    val externalIds: ExternalIds? = null,
    val metadata: LooseMetadata? = null,
)

@Serializable
data class Collection(
    val id: String,
    val name: String,
    val movies: List<MediaItem>,
)

// ---------- progress --------------------------------------------------------

@Serializable
data class WatchProgress(
    val mediaId: String,
    val positionMs: Int,
    val durationMs: Int,
    val watched: Boolean,
    val updatedAt: Long,
)

@Serializable
data class ContinueWatchingItem(
    val mediaId: String,
    val kind: String,
    val positionMs: Int,
    val durationMs: Int,
    val percent: Int,
    val updatedAt: Long,
    val media: MediaItem,
    val show: MediaItem? = null,
)

// ---------- sessions --------------------------------------------------------

@Serializable
data class Capabilities(
    val videoCodecs: List<String>,
    val audioCodecs: List<String>,
    val hdr: List<String>,
    val maxBitrate: Int,
    val container: List<String>,
)

@Serializable
data class CreateSessionBody(
    val mediaId: String,
    val capabilities: Capabilities,
    val audioTrackIndex: Int = 0,
    val subtitleTrackIndex: Int? = null,
    val userId: String? = null,
    val startPositionMs: Int? = null,
)

@Serializable
data class QualityProfile(
    val name: String? = null,
    val videoBitrate: Int,
    val audioBitrate: Int,
    val width: Int? = null,
    val height: Int? = null,
)

@Serializable
data class SessionInfo(
    val sessionId: String,
    val method: String,
    val streamUrl: String,
    val wsUrl: String,
    val profiles: List<QualityProfile>,
    val selectedAudioTrack: Int,
    val selectedSubtitleTrack: Int? = null,
)

// ---------- progress WS -----------------------------------------------------

@Serializable
data class ProgressReportMessage(
    val type: String = "progress",
    val positionMs: Int,
    val durationMs: Int,
)

// ---------- errors ----------------------------------------------------------

@Serializable
data class ErrorBody(val error: String? = null, val code: String? = null)
```

- [ ] **Step 4: Run the test and watch it pass**

Run:

```bash
cd tv && ./gradlew :app:testDebugUnitTest --tests '*ModelsTest*'
```

Expected: PASS.

- [ ] **Step 5: Add a round-trip test for `MediaItem` against the shape the server returns for shows (lots of nulls)**

Append to `ModelsTest.kt`:

```kotlin
    @Test fun `mediaItem decodes show row with null file-backed fields`() {
        val raw = """
            {"id":"s1","kind":"show","title":"Show","parentId":null,
             "sortYear":null,"season":null,"episode":null,
             "durationSec":null,"resolution":null,"videoCodec":null,
             "container":null,"hdr":null,"audioTracks":null,
             "subtitleTracks":null,"externalIds":null,
             "metadata":{"title":"Show","posterPath":"/p.jpg"}}
        """.trimIndent()
        val m = json.decodeFromString(MediaItem.serializer(), raw)
        assertEquals("s1", m.id)
        assertEquals("show", m.kind)
        assertNull(m.durationSec)
        assertEquals("/p.jpg", m.metadata?.posterPath)
    }
```

- [ ] **Step 6: Run and verify both tests pass**

Run:

```bash
cd tv && ./gradlew :app:testDebugUnitTest --tests '*ModelsTest*'
```

Expected: 2 tests, both PASS.

- [ ] **Step 7: Commit**

```bash
git add tv/app/src/main/java/network/luuk/horizontv/api/Models.kt \
        tv/app/src/test/java/network/luuk/horizontv/api/ModelsTest.kt
git commit -m "feat(tv): API models matching existing server contract"
```

---

### Task 4: `HorizonApi` — typed endpoints over OkHttp

**Files:**
- Create: `tv/app/src/main/java/network/luuk/horizontv/api/HorizonApi.kt`

- [ ] **Step 1: Write the implementation**

Create `tv/app/src/main/java/network/luuk/horizontv/api/HorizonApi.kt`:

```kotlin
package network.luuk.horizontv.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.serializer
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.logging.HttpLoggingInterceptor
import java.util.concurrent.TimeUnit

/**
 * Thin typed wrapper over OkHttp. Each call is a `suspend` that runs on
 * [Dispatchers.IO]. Failures surface as [ApiException] so callers can render
 * `error.code` / `error.message` without parsing bodies twice.
 */
class HorizonApi(
    private val baseUrl: String,
    val okHttp: OkHttpClient = defaultClient(),
) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    // ----- users -----
    suspend fun listUsers(): List<User> = get("/users", serializer())
    suspend fun createUser(body: CreateUserBody): User = post("/users", body, serializer())
    suspend fun deleteUser(id: String): Unit = delete("/users/$id")

    // ----- library -----
    suspend fun listMovies(): List<MediaItem> = get("/library/movies", serializer())
    suspend fun listShows(): List<ShowSummary> = get("/library/shows", serializer())
    suspend fun listCollections(): List<Collection> = get("/library/collections", serializer())

    suspend fun getShow(id: String): ShowSummary = get("/library/shows/$id", serializer())
    suspend fun listEpisodes(showId: String, season: Int): List<MediaItem> =
        get("/library/shows/$showId/seasons/$season/episodes", serializer())

    // ----- progress -----
    suspend fun continueWatching(userId: String): List<ContinueWatchingItem> =
        get("/progress/continue-watching?userId=$userId", serializer())

    suspend fun getProgress(userId: String, mediaId: String): WatchProgress? =
        try { get("/progress/$userId/$mediaId", serializer<WatchProgress>()) }
        catch (e: ApiException) { if (e.status == 404) null else throw e }

    // ----- sessions -----
    suspend fun createSession(body: CreateSessionBody): SessionInfo =
        post("/sessions", body, serializer())
    suspend fun destroySession(id: String) = delete("/sessions/$id")

    // ----- generic helpers --------------------------------------------------

    private suspend fun <T> get(path: String, ser: KSerializer<T>): T =
        exec(Request.Builder().url(baseUrl + path).get(), ser)

    private suspend inline fun <reified Body, T> post(
        path: String,
        body: Body,
        ser: KSerializer<T>,
    ): T {
        val payload = json.encodeToString(serializer(), body)
        val req = Request.Builder()
            .url(baseUrl + path)
            .post(payload.toRequestBody(jsonMedia))
        return exec(req, ser)
    }

    private suspend fun delete(path: String) {
        val req = Request.Builder().url(baseUrl + path).delete()
        exec(req, serializer<Unit>())
    }

    private suspend fun <T> exec(req: Request.Builder, ser: KSerializer<T>): T =
        withContext(Dispatchers.IO) {
            val userId = currentUserIdHeader.get()
            if (userId != null) req.header("X-Horizon-User", userId)
            okHttp.newCall(req.build()).execute().use { resp ->
                val body = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) {
                    val parsed = runCatching { json.decodeFromString(ErrorBody.serializer(), body) }.getOrNull()
                    throw ApiException(resp.code, parsed?.code, parsed?.error ?: "HTTP ${resp.code}")
                }
                if (ser.descriptor.serialName == "kotlin.Unit") {
                    @Suppress("UNCHECKED_CAST") return@withContext Unit as T
                }
                if (body.isEmpty()) throw ApiException(resp.code, "empty-body", "Empty response")
                json.decodeFromString(ser, body)
            }
        }

    companion object {
        /** Per-thread active user id — set by AppState, picked up by each request. */
        private val currentUserIdHeader = ThreadLocal<String?>()

        fun setActiveUserForRequests(id: String?) { currentUserIdHeader.set(id) }

        fun defaultClient(): OkHttpClient {
            val logger = HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC }
            return OkHttpClient.Builder()
                .connectTimeout(5, TimeUnit.SECONDS)
                .readTimeout(60, TimeUnit.SECONDS)
                .writeTimeout(15, TimeUnit.SECONDS)
                .addInterceptor(logger)
                .build()
        }
    }
}

class ApiException(
    val status: Int,
    val code: String?,
    override val message: String,
) : RuntimeException(message)
```

- [ ] **Step 2: Verify it compiles**

Run from `tv/`:

```bash
./gradlew :app:compileDebugKotlin
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 3: Commit**

```bash
git add tv/app/src/main/java/network/luuk/horizontv/api/HorizonApi.kt
git commit -m "feat(tv): typed HorizonApi over OkHttp with suspend helpers"
```

---

### Task 5: Capabilities probe + mapping tables

**Files:**
- Create: `tv/app/src/main/java/network/luuk/horizontv/api/CapabilitiesProbe.kt`
- Create: `tv/app/src/test/java/network/luuk/horizontv/api/CapabilitiesProbeTest.kt`

- [ ] **Step 1: Write failing tests for the pure mapping helpers**

Create `tv/app/src/test/java/network/luuk/horizontv/api/CapabilitiesProbeTest.kt`:

```kotlin
package network.luuk.horizontv.api

import org.junit.Assert.assertEquals
import org.junit.Test

class CapabilitiesProbeTest {

    @Test fun `video MIME mapping covers the codecs the server knows`() {
        assertEquals("h264", CapabilitiesProbe.mimeToVideoName("video/avc"))
        assertEquals("hevc", CapabilitiesProbe.mimeToVideoName("video/hevc"))
        assertEquals("av1",  CapabilitiesProbe.mimeToVideoName("video/av01"))
        assertEquals("vp9",  CapabilitiesProbe.mimeToVideoName("video/x-vnd.on2.vp9"))
    }

    @Test fun `video MIME mapping returns null for unknown codecs`() {
        assertEquals(null, CapabilitiesProbe.mimeToVideoName("video/mp4v-es"))
    }

    @Test fun `audio MIME mapping covers AC3 + EAC3 + DTS + TrueHD + AAC`() {
        assertEquals("aac",    CapabilitiesProbe.mimeToAudioName("audio/mp4a-latm"))
        assertEquals("ac3",    CapabilitiesProbe.mimeToAudioName("audio/ac3"))
        assertEquals("eac3",   CapabilitiesProbe.mimeToAudioName("audio/eac3"))
        assertEquals("dts",    CapabilitiesProbe.mimeToAudioName("audio/vnd.dts"))
        assertEquals("dts-hd", CapabilitiesProbe.mimeToAudioName("audio/vnd.dts.hd"))
        assertEquals("truehd", CapabilitiesProbe.mimeToAudioName("audio/true-hd"))
        assertEquals("flac",   CapabilitiesProbe.mimeToAudioName("audio/flac"))
        assertEquals("opus",   CapabilitiesProbe.mimeToAudioName("audio/opus"))
    }

    @Test fun `hdr int codes map to server names`() {
        // HDR_TYPE_HDR10 = 2, HDR_TYPE_HDR10_PLUS = 4, HDR_TYPE_DOLBY_VISION = 1
        assertEquals("hdr10",     CapabilitiesProbe.hdrTypeToName(2))
        assertEquals("hdr10plus", CapabilitiesProbe.hdrTypeToName(4))
        assertEquals("dv",        CapabilitiesProbe.hdrTypeToName(1))
        assertEquals(null,        CapabilitiesProbe.hdrTypeToName(3))  // HLG ignored
    }

    @Test fun `audio encoding ints map to passthrough codec names`() {
        // ENCODING_AC3 = 5, ENCODING_E_AC3 = 6, ENCODING_DTS = 7,
        // ENCODING_DTS_HD = 8, ENCODING_DOLBY_TRUEHD = 14
        assertEquals("ac3",    CapabilitiesProbe.audioEncodingToName(5))
        assertEquals("eac3",   CapabilitiesProbe.audioEncodingToName(6))
        assertEquals("dts",    CapabilitiesProbe.audioEncodingToName(7))
        assertEquals("dts-hd", CapabilitiesProbe.audioEncodingToName(8))
        assertEquals("truehd", CapabilitiesProbe.audioEncodingToName(14))
        assertEquals(null,     CapabilitiesProbe.audioEncodingToName(2))  // PCM
    }
}
```

- [ ] **Step 2: Run and watch it fail**

Run:

```bash
cd tv && ./gradlew :app:testDebugUnitTest --tests '*CapabilitiesProbeTest*'
```

Expected: FAIL — `Unresolved reference: CapabilitiesProbe`.

- [ ] **Step 3: Write the probe with pure + platform halves**

Create `tv/app/src/main/java/network/luuk/horizontv/api/CapabilitiesProbe.kt`:

```kotlin
package network.luuk.horizontv.api

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.MediaCodecList
import android.os.Build
import android.view.Display

object CapabilitiesProbe {

    /** Pure mapping — exposed for unit tests. Returns null for anything the
     *  server doesn't have a name for. */
    fun mimeToVideoName(mime: String): String? = when (mime.lowercase()) {
        "video/avc"            -> "h264"
        "video/hevc"           -> "hevc"
        "video/av01"           -> "av1"
        "video/x-vnd.on2.vp9"  -> "vp9"
        else                   -> null
    }

    fun mimeToAudioName(mime: String): String? = when (mime.lowercase()) {
        "audio/mp4a-latm" -> "aac"
        "audio/ac3"       -> "ac3"
        "audio/eac3"      -> "eac3"
        "audio/vnd.dts"   -> "dts"
        "audio/vnd.dts.hd"-> "dts-hd"
        "audio/true-hd"   -> "truehd"
        "audio/flac"      -> "flac"
        "audio/opus"      -> "opus"
        else              -> null
    }

    fun hdrTypeToName(type: Int): String? = when (type) {
        Display.HdrCapabilities.HDR_TYPE_HDR10         -> "hdr10"
        Display.HdrCapabilities.HDR_TYPE_HDR10_PLUS    -> "hdr10plus"
        Display.HdrCapabilities.HDR_TYPE_DOLBY_VISION  -> "dv"
        else                                           -> null    // HLG + future types not claimed
    }

    fun audioEncodingToName(enc: Int): String? = when (enc) {
        AudioFormat.ENCODING_AC3           -> "ac3"
        AudioFormat.ENCODING_E_AC3         -> "eac3"
        AudioFormat.ENCODING_DTS           -> "dts"
        AudioFormat.ENCODING_DTS_HD        -> "dts-hd"
        AudioFormat.ENCODING_DOLBY_TRUEHD  -> "truehd"
        else                               -> null
    }

    /** Platform probe — called once from `HorizonApp.onCreate`. */
    fun detect(context: Context): Capabilities {
        val codecs = MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos
        val videoNames = codecs
            .filter { !it.isEncoder }
            .flatMap { it.supportedTypes.toList() }
            .mapNotNull { mimeToVideoName(it) }
            .distinct()
        val decoderAudioNames = codecs
            .filter { !it.isEncoder }
            .flatMap { it.supportedTypes.toList() }
            .mapNotNull { mimeToAudioName(it) }
            .distinct()

        // Audio passthrough — HDMI/SPDIF output encodings the device can emit
        // bit-exact. If there's no HDMI yet (e.g. TV not yet connected) this
        // returns empty; decoder list above still covers decode-and-render.
        val audioPassthrough = detectPassthrough(context)
        val audioNames = (decoderAudioNames + audioPassthrough).distinct()

        // HDR — Display.HdrCapabilities is API 24+. SDR-only on older devices.
        val hdrNames = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            val display = context.getSystemService(android.hardware.display.DisplayManager::class.java)
                ?.getDisplay(Display.DEFAULT_DISPLAY)
            display?.hdrCapabilities?.supportedHdrTypes
                ?.mapNotNull(::hdrTypeToName)
                ?.distinct()
                .orEmpty()
        } else emptyList()

        return Capabilities(
            videoCodecs = videoNames,
            audioCodecs = audioNames,
            hdr         = hdrNames,
            maxBitrate  = 0,
            container   = listOf("matroska", "mp4", "mkv", "ts"),
        )
    }

    private fun detectPassthrough(context: Context): List<String> {
        val am = context.getSystemService(AudioManager::class.java) ?: return emptyList()
        val devices = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        val encodings = devices
            .filter {
                it.type == AudioDeviceInfo.TYPE_HDMI ||
                it.type == AudioDeviceInfo.TYPE_HDMI_ARC ||
                it.type == AudioDeviceInfo.TYPE_AUX_LINE
            }
            .flatMap { it.encodings.toList() }
            .distinct()
        return encodings.mapNotNull(::audioEncodingToName)
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
cd tv && ./gradlew :app:testDebugUnitTest --tests '*CapabilitiesProbeTest*'
```

Expected: 5 tests, all PASS.

- [ ] **Step 5: Verify full app still compiles**

Run from `tv/`:

```bash
./gradlew :app:assembleDebug
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 6: Commit**

```bash
git add tv/app/src/main/java/network/luuk/horizontv/api/CapabilitiesProbe.kt \
        tv/app/src/test/java/network/luuk/horizontv/api/CapabilitiesProbeTest.kt
git commit -m "feat(tv): capabilities probe — MediaCodecList + HDR + audio passthrough"
```

---

### Task 6: AppState + Application wiring

**Files:**
- Create: `tv/app/src/main/java/network/luuk/horizontv/app/AppState.kt`
- Modify: `tv/app/src/main/java/network/luuk/horizontv/HorizonApp.kt`

- [ ] **Step 1: Write `AppState`**

Create `tv/app/src/main/java/network/luuk/horizontv/app/AppState.kt`:

```kotlin
package network.luuk.horizontv.app

import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import network.luuk.horizontv.api.Capabilities
import network.luuk.horizontv.api.HorizonApi
import network.luuk.horizontv.api.User

/**
 * Top-of-process singleton. Built in [network.luuk.horizontv.HorizonApp.onCreate]
 * and published to the Compose tree via [LocalAppState]. Holds:
 *  - `api`           — the [HorizonApi] with the configured base URL
 *  - `capabilities`  — the probed device caps; immutable for the process lifetime
 *  - `activeUser`    — the profile the user picked; null until they pick one
 */
class AppState(
    val api: HorizonApi,
    val capabilities: Capabilities,
) {
    var activeUser: User? by mutableStateOf(null)
        private set

    fun setActiveUser(user: User?) {
        activeUser = user
        HorizonApi.setActiveUserForRequests(user?.id)
    }
}

val LocalAppState = compositionLocalOf<AppState> {
    error("AppState not provided — forgot CompositionLocalProvider in MainActivity?")
}
```

- [ ] **Step 2: Update `HorizonApp` to build the state eagerly**

Replace `tv/app/src/main/java/network/luuk/horizontv/HorizonApp.kt`:

```kotlin
package network.luuk.horizontv

import android.app.Application
import network.luuk.horizontv.api.CapabilitiesProbe
import network.luuk.horizontv.api.HorizonApi
import network.luuk.horizontv.app.AppState

class HorizonApp : Application() {

    lateinit var state: AppState
        private set

    override fun onCreate() {
        super.onCreate()
        val api = HorizonApi(baseUrl = BuildConfig.SERVER_URL)
        val caps = CapabilitiesProbe.detect(this)
        state = AppState(api = api, capabilities = caps)
    }
}
```

- [ ] **Step 3: Verify compile**

Run from `tv/`:

```bash
./gradlew :app:assembleDebug
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 4: Commit**

```bash
git add tv/app/src/main/java/network/luuk/horizontv/app/AppState.kt \
        tv/app/src/main/java/network/luuk/horizontv/HorizonApp.kt
git commit -m "feat(tv): AppState singleton + Application wiring"
```

---

### Task 7: MainActivity + NavHost

**Files:**
- Modify: `tv/app/src/main/java/network/luuk/horizontv/MainActivity.kt`
- Create: `tv/app/src/main/java/network/luuk/horizontv/ui/Routes.kt`

- [ ] **Step 1: Centralize route strings**

Create `tv/app/src/main/java/network/luuk/horizontv/ui/Routes.kt`:

```kotlin
package network.luuk.horizontv.ui

/** All routes used by the NavHost, in one place. */
object Routes {
    const val PROFILE_LIST = "profile_list"
    const val LIBRARY      = "library"
    const val SHOW_DETAIL  = "show/{showId}"
    const val PLAYER       = "player/{mediaId}?resume={resume}"

    fun showDetail(showId: String) = "show/$showId"
    fun player(mediaId: String, resume: Boolean = false) =
        "player/$mediaId?resume=$resume"
}
```

- [ ] **Step 2: Update MainActivity with NavHost scaffold and placeholder screens**

Replace `tv/app/src/main/java/network/luuk/horizontv/MainActivity.kt`:

```kotlin
package network.luuk.horizontv

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import network.luuk.horizontv.app.LocalAppState
import network.luuk.horizontv.ui.Routes

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val state = (application as HorizonApp).state
        setContent {
            CompositionLocalProvider(LocalAppState provides state) {
                val nav = rememberNavController()
                NavHost(nav, startDestination = Routes.PROFILE_LIST) {
                    composable(Routes.PROFILE_LIST) {
                        Text("profile list — wired in Task 8")
                    }
                    composable(Routes.LIBRARY) {
                        Text("library — wired in Task 9")
                    }
                    composable(
                        Routes.SHOW_DETAIL,
                        arguments = listOf(navArgument("showId") { type = NavType.StringType }),
                    ) {
                        Text("show detail — wired in Task 10")
                    }
                    composable(
                        Routes.PLAYER,
                        arguments = listOf(
                            navArgument("mediaId") { type = NavType.StringType },
                            navArgument("resume")  {
                                type = NavType.BoolType
                                defaultValue = false
                            },
                        ),
                    ) {
                        Text("player — wired in Task 12")
                    }
                }
            }
        }
    }
}
```

- [ ] **Step 3: Compile**

Run from `tv/`:

```bash
./gradlew :app:assembleDebug
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 4: Commit**

```bash
git add tv/app/src/main/java/network/luuk/horizontv/MainActivity.kt \
        tv/app/src/main/java/network/luuk/horizontv/ui/Routes.kt
git commit -m "feat(tv): NavHost with four route stubs"
```

---

### Task 8: Profile list screen

**Files:**
- Create: `tv/app/src/main/java/network/luuk/horizontv/ui/ProfileListScreen.kt`
- Modify: `tv/app/src/main/java/network/luuk/horizontv/MainActivity.kt` (wire the composable)

- [ ] **Step 1: Implement `ProfileListScreen`**

Create `tv/app/src/main/java/network/luuk/horizontv/ui/ProfileListScreen.kt`:

```kotlin
package network.luuk.horizontv.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.tv.material3.ListItem
import androidx.tv.material3.ListItemDefaults
import kotlinx.coroutines.launch
import network.luuk.horizontv.api.CreateUserBody
import network.luuk.horizontv.api.User
import network.luuk.horizontv.app.LocalAppState

@Composable
fun ProfileListScreen(onUserPicked: () -> Unit) {
    val state = LocalAppState.current
    val scope = rememberCoroutineScope()

    var users by remember { mutableStateOf<List<User>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }

    var showAdd by remember { mutableStateOf(false) }
    var showDelete by remember { mutableStateOf<User?>(null) }

    suspend fun reload() {
        loading = true
        try { users = state.api.listUsers(); error = null }
        catch (e: Throwable) { error = e.message }
        finally { loading = false }
    }

    LaunchedEffect(Unit) { reload() }

    Column(
        Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Who's watching?")
        when {
            loading -> Text("Loading…")
            error != null -> Text("Error: $error")
            else -> LazyColumn(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                items(users, key = { it.id }) { user ->
                    ListItem(
                        selected = false,
                        onClick = {
                            state.setActiveUser(user)
                            onUserPicked()
                        },
                        onLongClick = { showDelete = user },
                        headlineContent = { Text(user.name) },
                        colors = ListItemDefaults.colors(),
                    )
                }
                item(key = "add") {
                    ListItem(
                        selected = false,
                        onClick = { showAdd = true },
                        headlineContent = { Text("+ Add profile") },
                    )
                }
            }
        }
    }

    if (showAdd) {
        AddProfileDialog(
            onDismiss = { showAdd = false },
            onSubmit = { name ->
                showAdd = false
                scope.launch {
                    try { state.api.createUser(CreateUserBody(name)); reload() }
                    catch (e: Throwable) { error = e.message }
                }
            },
        )
    }

    val toDelete = showDelete
    if (toDelete != null) {
        AlertDialog(
            onDismissRequest = { showDelete = null },
            confirmButton = {
                TextButton(onClick = {
                    showDelete = null
                    scope.launch {
                        try { state.api.deleteUser(toDelete.id); reload() }
                        catch (e: Throwable) { error = e.message }
                    }
                }) { Text("Delete") }
            },
            dismissButton = {
                TextButton(onClick = { showDelete = null }) { Text("Cancel") }
            },
            title = { Text("Delete profile?") },
            text = { Text("Remove \"${toDelete.name}\" and its watch history?") },
        )
    }
}

@Composable
private fun AddProfileDialog(onDismiss: () -> Unit, onSubmit: (String) -> Unit) {
    var name by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            Button(onClick = { if (name.isNotBlank()) onSubmit(name.trim()) }) { Text("Add") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        title = { Text("New profile") },
        text = {
            OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("Name") })
        },
    )
}
```

- [ ] **Step 2: Wire it into the NavHost**

In `tv/app/src/main/java/network/luuk/horizontv/MainActivity.kt`, replace the `Routes.PROFILE_LIST` composable block:

```kotlin
                    composable(Routes.PROFILE_LIST) {
                        ProfileListScreen(onUserPicked = {
                            nav.navigate(Routes.LIBRARY) {
                                popUpTo(Routes.PROFILE_LIST) { inclusive = true }
                            }
                        })
                    }
```

Also add the import at the top:

```kotlin
import network.luuk.horizontv.ui.ProfileListScreen
```

- [ ] **Step 3: Compile**

Run from `tv/`:

```bash
./gradlew :app:assembleDebug
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 4: Commit**

```bash
git add tv/app/src/main/java/network/luuk/horizontv/ui/ProfileListScreen.kt \
        tv/app/src/main/java/network/luuk/horizontv/MainActivity.kt
git commit -m "feat(tv): profile list screen with add + long-press delete"
```

---

### Task 9: Library screen — tabs + Continue Watching rail + grid

**Files:**
- Create: `tv/app/src/main/java/network/luuk/horizontv/ui/LibraryScreen.kt`
- Create: `tv/app/src/main/java/network/luuk/horizontv/ui/Poster.kt`
- Modify: `tv/app/src/main/java/network/luuk/horizontv/MainActivity.kt`

- [ ] **Step 1: Add a small `Poster` composable that loads via Coil 3**

Create `tv/app/src/main/java/network/luuk/horizontv/ui/Poster.kt`:

```kotlin
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
```

- [ ] **Step 2: Write `LibraryScreen`**

Create `tv/app/src/main/java/network/luuk/horizontv/ui/LibraryScreen.kt`:

```kotlin
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
```

- [ ] **Step 3: Wire it into `MainActivity`**

In `tv/app/src/main/java/network/luuk/horizontv/MainActivity.kt`, replace the `Routes.LIBRARY` composable block:

```kotlin
                    composable(Routes.LIBRARY) {
                        LibraryScreen(
                            onShowClick  = { id -> nav.navigate(Routes.showDetail(id)) },
                            onMovieClick = { id, resume -> nav.navigate(Routes.player(id, resume)) },
                        )
                    }
```

Add to imports:

```kotlin
import network.luuk.horizontv.ui.LibraryScreen
```

- [ ] **Step 4: Compile**

Run from `tv/`:

```bash
./gradlew :app:assembleDebug
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 5: Commit**

```bash
git add tv/app/src/main/java/network/luuk/horizontv/ui/LibraryScreen.kt \
        tv/app/src/main/java/network/luuk/horizontv/ui/Poster.kt \
        tv/app/src/main/java/network/luuk/horizontv/MainActivity.kt
git commit -m "feat(tv): library screen — tabs, Continue Watching rail, grid"
```

---

### Task 10: Show detail screen

**Files:**
- Create: `tv/app/src/main/java/network/luuk/horizontv/ui/ShowDetailScreen.kt`
- Modify: `tv/app/src/main/java/network/luuk/horizontv/MainActivity.kt`

- [ ] **Step 1: Write `ShowDetailScreen`**

Create `tv/app/src/main/java/network/luuk/horizontv/ui/ShowDetailScreen.kt`:

```kotlin
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
import androidx.compose.material3.ListItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
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
            season = s.seasons.firstOrNull()?.number
            if (season != null) episodes = state.api.listEpisodes(showId, season!!)
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
```

- [ ] **Step 2: Wire it into `MainActivity`**

In `MainActivity.kt`, replace the `Routes.SHOW_DETAIL` composable:

```kotlin
                    composable(
                        Routes.SHOW_DETAIL,
                        arguments = listOf(navArgument("showId") { type = NavType.StringType }),
                    ) { entry ->
                        val id = entry.arguments!!.getString("showId")!!
                        ShowDetailScreen(
                            showId = id,
                            onPlayEpisode = { episodeId -> nav.navigate(Routes.player(episodeId)) },
                        )
                    }
```

Add to imports:

```kotlin
import network.luuk.horizontv.ui.ShowDetailScreen
```

- [ ] **Step 3: Compile**

Run from `tv/`:

```bash
./gradlew :app:assembleDebug
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 4: Commit**

```bash
git add tv/app/src/main/java/network/luuk/horizontv/ui/ShowDetailScreen.kt \
        tv/app/src/main/java/network/luuk/horizontv/MainActivity.kt
git commit -m "feat(tv): show detail with season pills + episode list"
```

---

### Task 11: `ProgressSocket` — WebSocket reporter

**Files:**
- Create: `tv/app/src/main/java/network/luuk/horizontv/api/ProgressSocket.kt`

- [ ] **Step 1: Write the socket**

Create `tv/app/src/main/java/network/luuk/horizontv/api/ProgressSocket.kt`:

```kotlin
package network.luuk.horizontv.api

import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/** Lightweight wrapper around an OkHttp WebSocket. Sends periodic progress
 *  updates — the server's WS handler is idempotent and ignores messages it
 *  doesn't recognise, so we don't need any ack handling. */
class ProgressSocket(
    private val client: OkHttpClient,
    private val baseHttpUrl: String,   // e.g. http://host:port
) {
    private val json = Json { encodeDefaults = true }
    private var socket: WebSocket? = null

    fun connect(wsPath: String) {
        disconnect()
        // Server returns ws path like "/sessions/:id/ws" — swap http[s] for ws[s].
        val wsUrl = baseHttpUrl
            .replaceFirst("http://", "ws://")
            .replaceFirst("https://", "wss://") + wsPath
        val req = Request.Builder().url(wsUrl).build()
        socket = client.newWebSocket(req, object : WebSocketListener() {
            override fun onFailure(ws: WebSocket, t: Throwable, r: okhttp3.Response?) {
                // Transient — next report attempt will create a new socket.
                socket = null
            }
        })
    }

    fun reportProgress(positionMs: Int, durationMs: Int) {
        val msg = ProgressReportMessage(positionMs = positionMs, durationMs = durationMs)
        val text = json.encodeToString(ProgressReportMessage.serializer(), msg)
        socket?.send(text)
    }

    fun disconnect() {
        socket?.close(1000, "bye")
        socket = null
    }
}
```

- [ ] **Step 2: Compile**

Run from `tv/`:

```bash
./gradlew :app:compileDebugKotlin
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 3: Commit**

```bash
git add tv/app/src/main/java/network/luuk/horizontv/api/ProgressSocket.kt
git commit -m "feat(tv): ProgressSocket WebSocket reporter"
```

---

### Task 12: Player screen — Media3 + resume toast

**Files:**
- Create: `tv/app/src/main/java/network/luuk/horizontv/ui/PlayerScreen.kt`
- Modify: `tv/app/src/main/java/network/luuk/horizontv/MainActivity.kt`

- [ ] **Step 1: Write `PlayerScreen`**

Create `tv/app/src/main/java/network/luuk/horizontv/ui/PlayerScreen.kt`:

```kotlin
package network.luuk.horizontv.ui

import android.view.ViewGroup
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionParameters
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import network.luuk.horizontv.BuildConfig
import network.luuk.horizontv.api.CreateSessionBody
import network.luuk.horizontv.api.ProgressSocket
import network.luuk.horizontv.api.SessionInfo
import network.luuk.horizontv.api.WatchProgress
import network.luuk.horizontv.app.LocalAppState

private const val RESUME_THRESHOLD_MS = 5_000

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

    // Fetch saved progress once.
    LaunchedEffect(mediaId) {
        val userId = state.activeUser?.id
        if (userId == null) { phase = Phase.Starting; return@LaunchedEffect }
        try {
            val p = state.api.getProgress(userId, mediaId)
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
            session = state.api.createSession(
                CreateSessionBody(
                    mediaId = mediaId,
                    capabilities = state.capabilities,
                    userId = state.activeUser?.id,
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
            .apply {
                trackSelectionParameters = TrackSelectionParameters.Builder(context)
                    .setTunnelingEnabled(true)
                    .build()
            }
    }

    val socket = remember { ProgressSocket(state.api.okHttp, BuildConfig.SERVER_URL) }

    val sess = session
    LaunchedEffect(sess) {
        if (sess == null) return@LaunchedEffect
        val streamUrl = if (sess.streamUrl.startsWith("http")) sess.streamUrl
                        else BuildConfig.SERVER_URL + sess.streamUrl
        player.setMediaItem(MediaItem.fromUri(streamUrl))
        player.prepare()
        player.playWhenReady = true
        socket.connect(sess.wsUrl)
    }

    // Periodic progress reports, every 5 s.
    LaunchedEffect(sess) {
        if (sess == null) return@LaunchedEffect
        while (true) {
            delay(5_000)
            val pos = player.currentPosition.toInt()
            val dur = player.duration.takeIf { it > 0 }?.toInt() ?: 0
            if (dur > 0) socket.reportProgress(pos, dur)
        }
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
                scope.launch { runCatching { state.api.destroySession(id) } }
            }
        }
    }

    BackHandler { onBack() }

    Box(Modifier.fillMaxSize()) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { ctx ->
                PlayerView(ctx).apply {
                    useController = true
                    this.player = player
                    layoutParams = ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT,
                    )
                }
            },
        )

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
```

- [ ] **Step 2: Wire `PlayerScreen` into `MainActivity`**

In `MainActivity.kt`, replace the `Routes.PLAYER` composable:

```kotlin
                    composable(
                        Routes.PLAYER,
                        arguments = listOf(
                            navArgument("mediaId") { type = NavType.StringType },
                            navArgument("resume")  {
                                type = NavType.BoolType
                                defaultValue = false
                            },
                        ),
                    ) { entry ->
                        val id = entry.arguments!!.getString("mediaId")!!
                        val resume = entry.arguments!!.getBoolean("resume", false)
                        PlayerScreen(
                            mediaId = id,
                            resumeDefault = resume,
                            onBack = { nav.popBackStack() },
                        )
                    }
```

Add to imports:

```kotlin
import network.luuk.horizontv.ui.PlayerScreen
```

- [ ] **Step 3: Compile**

Run from `tv/`:

```bash
./gradlew :app:assembleDebug
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 4: Commit**

```bash
git add tv/app/src/main/java/network/luuk/horizontv/ui/PlayerScreen.kt \
        tv/app/src/main/java/network/luuk/horizontv/MainActivity.kt
git commit -m "feat(tv): player screen with Media3 + resume toast + WS progress"
```

---

### Task 13: README + deploy helper

**Files:**
- Create: `tv/README.md`
- Create: `tv/bin/deploy-shield`
- Modify: `/Users/luuk/Projects/slimluccii/horizon/README.md` (if present) — add one bullet pointing at `tv/README.md`

- [ ] **Step 1: Write `tv/README.md`**

Create `tv/README.md`:

```markdown
# Horizon TV

Android TV / Google TV client for the Horizon media server. Targets anything
from Android 6 up — reference device is Nvidia Shield TV Pro.

## First-time setup

1. Install Android Studio Ladybug or newer.
2. Open `tv/` as a Gradle project (File → Open → pick this folder).
3. Copy `tv/local.properties.example` to `tv/local.properties` and set
   `HORIZON_SERVER_URL` to your server's LAN URL.
4. On your Shield: Settings → Device Preferences → About → Build × 7 to
   enable developer mode, then Developer options → Network debugging.
5. From your Mac:
   ```
   adb connect <shield-ip>:5555
   cd tv
   ./bin/deploy-shield
   ```

## Stack

See `docs/superpowers/specs/2026-04-24-android-tv-client-design.md`.
```

- [ ] **Step 2: Write the deploy helper**

Create `tv/bin/deploy-shield`:

```bash
#!/usr/bin/env bash
set -euo pipefail

SHIELD_IP="${SHIELD_IP:-${1:-}}"
if [ -z "${SHIELD_IP}" ]; then
  echo "usage: SHIELD_IP=<ip> $0   OR   $0 <ip>" >&2
  exit 2
fi

cd "$(dirname "$0")/.."

adb connect "${SHIELD_IP}:5555"
./gradlew :app:installDebug
adb -s "${SHIELD_IP}:5555" shell monkey \
  -p network.luuk.horizontv \
  -c android.intent.category.LEANBACK_LAUNCHER 1
```

Make it executable:

```bash
chmod +x tv/bin/deploy-shield
```

- [ ] **Step 3: Final smoke — assembleDebug + unit tests both green**

Run from `tv/`:

```bash
./gradlew :app:assembleDebug :app:testDebugUnitTest
```

Expected: both tasks `BUILD SUCCESSFUL`, all unit tests pass.

- [ ] **Step 4: Commit**

```bash
git add tv/README.md tv/bin/deploy-shield
git commit -m "docs(tv): README + Shield deploy helper"
```

---

## Spec coverage self-check

- Profile picker (list/pick/add/delete) → **Task 8** ✓
- Library with tabs + CW rail + grid → **Task 9** ✓
- Show detail (seasons + episodes) → **Task 10** ✓
- Player with resume toast + Media3 + back-to-dismiss → **Task 12** ✓
- WS progress reporter → **Task 11**, invoked from Task 12 ✓
- Coil 3 poster loading → **Task 9** (`Poster.kt`) ✓
- Capabilities probe (MediaCodecList + HDR + audio passthrough) → **Task 5** ✓
- minSdk 23 / Compose for TV / Media3 / OkHttp / kotlinx.serialization → **Task 1–2** ✓
- ABI split + R8 full mode + `nonTransitiveRClass` → **Task 1–2** ✓
- AndroidManifest with Leanback-only launcher + cleartext config → **Task 2** ✓
- Tunneled decode + frame-rate switching + audio offload → **Task 12** ✓
- Deploy via ADB → **Task 13** ✓
- Server changes: **none required** ✓
