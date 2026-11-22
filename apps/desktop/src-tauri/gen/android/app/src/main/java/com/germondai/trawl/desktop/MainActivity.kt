package com.germondai.trawl.desktop

import android.os.Bundle
import android.app.UiModeManager
import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.activity.addCallback
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var appWebView: WebView? = null
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
    onBackPressedDispatcher.addCallback(this) {
      if (ViewCompat.getRootWindowInsets(window.decorView)?.isVisible(WindowInsetsCompat.Type.ime()) == true) {
        WindowInsetsControllerCompat(window, window.decorView).hide(WindowInsetsCompat.Type.ime())
      } else {
        val web = appWebView
        if (web != null && web.canGoBack()) web.goBack() else moveTaskToBack(true)
      }
    }
  }
}
