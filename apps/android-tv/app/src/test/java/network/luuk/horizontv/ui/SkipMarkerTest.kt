package network.luuk.horizontv.ui

import android.view.KeyEvent
import network.luuk.horizontv.api.Marker
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SkipMarkerTest {

    private val recap = Marker(kind = "recap", startMs = 4_000, endMs = 89_000)
    private val intro = Marker(kind = "intro", startMs = 93_000, endMs = 117_000)
    private val credits = Marker(kind = "credits", startMs = 2_815_000, endMs = 3_037_000)
    private val markers = listOf(recap, intro, credits)

    @Test fun `the marker the position lies in is skippable`() {
        assertEquals(intro, skippableAt(markers, 100_000))
        assertEquals(recap, skippableAt(markers, 10_000))
    }

    @Test fun `the start is included and the end excluded, so the chip goes away as the marker ends`() {
        assertEquals(intro, skippableAt(markers, 93_000))
        assertNull(skippableAt(markers, 117_000))
    }

    @Test fun `credits are not skippable, there is nothing after them to skip to`() {
        assertNull(skippableAt(markers, 2_900_000))
    }

    @Test fun `nothing is skippable between markers or without markers`() {
        assertNull(skippableAt(markers, 90_000))
        assertNull(skippableAt(emptyList(), 10))
    }

    @Test fun `OK skips while the chip is up and the controls are hidden`() {
        assertTrue(skipConsumesKey(KeyEvent.KEYCODE_DPAD_CENTER, chipVisible = true, controllerVisible = false))
        assertTrue(skipConsumesKey(KeyEvent.KEYCODE_ENTER, chipVisible = true, controllerVisible = false))
    }

    @Test fun `OK reaches the controls when they are on screen`() {
        assertFalse(skipConsumesKey(KeyEvent.KEYCODE_DPAD_CENTER, chipVisible = true, controllerVisible = true))
    }

    @Test fun `OK reaches the player when there is nothing to skip`() {
        assertFalse(skipConsumesKey(KeyEvent.KEYCODE_DPAD_CENTER, chipVisible = false, controllerVisible = false))
    }

    @Test fun `other keys always reach the player`() {
        assertFalse(skipConsumesKey(KeyEvent.KEYCODE_DPAD_RIGHT, chipVisible = true, controllerVisible = false))
        assertFalse(skipConsumesKey(KeyEvent.KEYCODE_BACK, chipVisible = true, controllerVisible = false))
    }
}
