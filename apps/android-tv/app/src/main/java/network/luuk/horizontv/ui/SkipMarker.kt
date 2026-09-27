package network.luuk.horizontv.ui

import android.view.KeyEvent
import network.luuk.horizontv.api.Marker

/** The marker to offer a skip for at this position; the end is exclusive and credits are never offered. */
fun skippableAt(markers: List<Marker>, positionMs: Long): Marker? =
    markers.firstOrNull { it.kind != "credits" && positionMs >= it.startMs && positionMs < it.endMs }

/** Whether a key press skips instead of reaching the player, which leaves OK to the controls while they show. */
fun skipConsumesKey(keyCode: Int, chipVisible: Boolean, controllerVisible: Boolean): Boolean =
    chipVisible && !controllerVisible &&
        (keyCode == KeyEvent.KEYCODE_DPAD_CENTER || keyCode == KeyEvent.KEYCODE_ENTER || keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER)
