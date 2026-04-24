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
