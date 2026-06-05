package network.luuk.horizontv

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.CompositionLocalProvider
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import network.luuk.horizontv.app.LocalAppState
import network.luuk.horizontv.ui.BootScreen
import network.luuk.horizontv.ui.LibraryScreen
import network.luuk.horizontv.ui.PlayerScreen
import network.luuk.horizontv.ui.ProfileListScreen
import network.luuk.horizontv.ui.Routes
import network.luuk.horizontv.ui.ServerPickerScreen
import network.luuk.horizontv.ui.ShowDetailScreen

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val state = (application as HorizonApp).state
        setContent {
            CompositionLocalProvider(LocalAppState provides state) {
                val nav = rememberNavController()
                NavHost(nav, startDestination = Routes.BOOT) {
                    composable(Routes.BOOT) {
                        BootScreen(
                            onConnected = {
                                nav.navigate(Routes.PROFILE_LIST) {
                                    popUpTo(Routes.BOOT) { inclusive = true }
                                }
                            },
                            onNeedPicker = {
                                nav.navigate(Routes.SERVER_PICKER) {
                                    popUpTo(Routes.BOOT) { inclusive = true }
                                }
                            },
                        )
                    }
                    composable(Routes.SERVER_PICKER) {
                        ServerPickerScreen(onPicked = {
                            nav.navigate(Routes.PROFILE_LIST) {
                                popUpTo(Routes.SERVER_PICKER) { inclusive = true }
                            }
                        })
                    }
                    composable(Routes.PROFILE_LIST) {
                        ProfileListScreen(
                            onUserPicked = {
                                nav.navigate(Routes.LIBRARY) {
                                    popUpTo(Routes.PROFILE_LIST) { inclusive = true }
                                }
                            },
                            onSwitchServer = { nav.navigate(Routes.SERVER_PICKER) },
                        )
                    }
                    composable(Routes.LIBRARY) {
                        LibraryScreen(
                            onShowClick  = { id -> nav.navigate(Routes.showDetail(id)) },
                            onMovieClick = { id, resume -> nav.navigate(Routes.player(id, resume)) },
                        )
                    }
                    composable(
                        Routes.SHOW_DETAIL,
                        arguments = listOf(navArgument("showId") { type = NavType.StringType }),
                    ) { entry ->
                        val id = entry.arguments?.getString("showId") ?: run {
                            nav.navigate(Routes.LIBRARY) {
                                popUpTo(Routes.SHOW_DETAIL) { inclusive = true }
                            }
                            return@composable
                        }
                        ShowDetailScreen(
                            showId = id,
                            onPlayEpisode = { episodeId -> nav.navigate(Routes.player(episodeId)) },
                        )
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
                    ) { entry ->
                        val id = entry.arguments?.getString("mediaId") ?: run {
                            nav.navigate(Routes.LIBRARY) {
                                popUpTo(Routes.PLAYER) { inclusive = true }
                            }
                            return@composable
                        }
                        val resume = entry.arguments?.getBoolean("resume", false) ?: false
                        PlayerScreen(
                            mediaId = id,
                            resumeDefault = resume,
                            onBack = { nav.popBackStack() },
                        )
                    }
                }
            }
        }
    }
}
