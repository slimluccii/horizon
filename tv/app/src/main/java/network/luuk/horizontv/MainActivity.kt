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
