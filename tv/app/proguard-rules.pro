# kotlinx.serialization keeps its own metadata — no rules needed in 1.6+.
# Media3 + Compose + OkHttp ship consumer rules. Keep this file minimal.

# Our serializable models live in api/Models.kt — keep their companions so
# kotlinx-serialization can find the generated serializers via reflection.
-keep class network.luuk.horizontv.api.** { *; }
-keepclassmembers class network.luuk.horizontv.api.** {
    public static ** Companion;
}
