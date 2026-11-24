package com.germondai.trawl.desktop

import android.os.Build
import android.os.Bundle
import android.app.UiModeManager
import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.webkit.WebView
import android.window.BackEvent
import android.window.OnBackAnimationCallback
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import androidx.annotation.RequiresApi
import androidx.activity.enableEdgeToEdge
import androidx.activity.OnBackPressedCallback
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var appWebView: WebView? = null
  private var hasPageBack = false
  private var previewingBack = false
  private var nativePageBack: OnBackInvokedCallback? = null
  private val legacyPageBack = object : OnBackPressedCallback(true) {
    override fun handleOnBackPressed() = finishBack()
  }

  private fun keyboardVisible() =
    ViewCompat.getRootWindowInsets(window.decorView)?.isVisible(WindowInsetsCompat.Type.ime()) == true

  fun setPageBackEnabled(enabled: Boolean) {
    hasPageBack = enabled
    if (Build.VERSION.SDK_INT >= 33) updateNativeBack()
  }

  @RequiresApi(33)
  private fun updateNativeBack() {
    if (hasPageBack && nativePageBack == null) {
      val callback = if (Build.VERSION.SDK_INT >= 34) animatedBack() else OnBackInvokedCallback { finishBack() }
      // WebView also handles its browser history at default priority. The app owns its navigation stack.
      onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_OVERLAY, callback)
      nativePageBack = callback
    } else if (!hasPageBack) {
      nativePageBack?.let(onBackInvokedDispatcher::unregisterOnBackInvokedCallback)
      nativePageBack = null
    }
  }

  @RequiresApi(34)
  private fun animatedBack() = object : OnBackAnimationCallback {
    override fun onBackStarted(event: BackEvent) {
      previewingBack = !keyboardVisible()
      if (previewingBack) sendBack("start", event.progress, if (event.swipeEdge == BackEvent.EDGE_RIGHT) -1 else 1)
    }
    override fun onBackProgressed(event: BackEvent) {
      if (previewingBack) sendBack("progress", event.progress)
    }
    override fun onBackCancelled() {
      if (previewingBack) sendBack("cancel")
      previewingBack = false
    }
    override fun onBackInvoked() = finishBack()
  }

  private fun finishBack() {
    if (keyboardVisible()) {
      if (previewingBack) sendBack("cancel")
      WindowInsetsControllerCompat(window, window.decorView).hide(WindowInsetsCompat.Type.ime())
    } else if (hasPageBack) {
      sendBack("commit")
    } else {
      moveTaskToBack(true)
    }
    previewingBack = false
  }

  private fun sendBack(phase: String, progress: Float = 0f, edge: Int = 1) {
    appWebView?.evaluateJavascript(
      "window.dispatchEvent(new CustomEvent('trawl-predictive-back', {detail:{phase:'$phase',progress:$progress,edge:$edge}}))",
      null
    )
  }

  private external fun nativeResume()
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    appWebView = webView
    val television = (getSystemService(Context.UI_MODE_SERVICE) as UiModeManager).currentModeType == Configuration.UI_MODE_TYPE_TELEVISION
    if (television) webView.settings.userAgentString += " TRAWL-TV"
  }
  override fun onResume() {
    super.onResume()
    com.germondai.trawl.mobile.RuntimePlugin.attach(this)
    com.germondai.trawl.mobile.RuntimeService.visible = true
    nativeResume()
    appWebView?.evaluateJavascript("window.dispatchEvent(new Event('trawl-foreground'))", null)
  }
  override fun onPause() {
    appWebView?.evaluateJavascript("window.dispatchEvent(new Event('trawl-background'))", null)
    com.germondai.trawl.mobile.RuntimeService.visible = false
    super.onPause()
  }
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    window.decorView.setBackgroundColor(Color.rgb(23, 23, 25))
    val content = findViewById<android.view.View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val safe = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
      view.setPadding(safe.left, safe.top, safe.right, safe.bottom)
      WindowInsetsCompat.CONSUMED
    }
    ViewCompat.requestApplyInsets(content)
    WindowInsetsControllerCompat(window, window.decorView).apply { isAppearanceLightStatusBars = false; isAppearanceLightNavigationBars = false }
    if (Build.VERSION.SDK_INT < 33) onBackPressedDispatcher.addCallback(this, legacyPageBack)
  }
}
