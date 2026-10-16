package com.r0adkll.drop.ui

import android.os.Build
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalContext
import com.r0adkll.drop.Drop

/**
 * Shows the Update sheet from a View-based activity: the same composable, hosted in a ComposeView
 * that removes itself when the sheet is dismissed. Without a Compose theme of its own, the sheet
 * uses Material 3's colours (dynamic colour on Android 12 and later) unless [theme] wraps it.
 */
public fun ComponentActivity.showDropUpdateSheet(
  drop: Drop,
  theme: @Composable (content: @Composable () -> Unit) -> Unit = { content -> DefaultTheme(content) },
) {
  val root = findViewById<ViewGroup>(android.R.id.content)
  val view = ComposeView(this)
  view.setContent {
    theme {
      DropUpdateSheet(drop = drop, onDismiss = { root.post { root.removeView(view) } })
    }
  }
  root.addView(view)
}

@Composable
private fun DefaultTheme(content: @Composable () -> Unit) {
  val dark = isSystemInDarkTheme()
  val context = LocalContext.current
  val colors = when {
    Build.VERSION.SDK_INT >= 31 && dark -> dynamicDarkColorScheme(context)
    Build.VERSION.SDK_INT >= 31 -> dynamicLightColorScheme(context)
    dark -> darkColorScheme()
    else -> lightColorScheme()
  }
  MaterialTheme(colorScheme = colors, content = content)
}
