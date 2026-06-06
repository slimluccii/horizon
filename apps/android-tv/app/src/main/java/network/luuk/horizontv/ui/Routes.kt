package network.luuk.horizontv.ui

/** All routes used by the NavHost, in one place. */
object Routes {
    const val BOOT          = "boot"
    const val AUTH          = "auth"
    const val SERVER_PICKER = "server_picker"
    const val PROFILE_LIST = "profile_list"
    const val LIBRARY      = "library"
    const val SHOW_DETAIL  = "show/{showId}"
    const val PLAYER       = "player/{mediaId}?resume={resume}"

    fun showDetail(showId: String) = "show/$showId"
    fun player(mediaId: String, resume: Boolean = false) =
        "player/$mediaId?resume=$resume"
}
