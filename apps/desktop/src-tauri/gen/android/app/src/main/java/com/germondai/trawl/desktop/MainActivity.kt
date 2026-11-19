package com.germondai.trawl.desktop

import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.activity.addCallback
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  override fun onResume() { super.onResume(); com.germondai.trawl.mobile.RuntimeService.visible = true }
  override fun onPause() { com.germondai.trawl.mobile.RuntimeService.visible = false; super.onPause() }
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    WindowInsetsControllerCompat(window, window.decorView).apply { isAppearanceLightStatusBars = false; isAppearanceLightNavigationBars = false }
    onBackPressedDispatcher.addCallback(this) { moveTaskToBack(true) }
  }
}
