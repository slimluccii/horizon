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
                ?.toList()
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
