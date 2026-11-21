package com.germondai.trawl.mobile

import android.content.Context
import androidx.core.content.ContextCompat
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature

/** Serialize the app-wide setting across renderer cancellation and service recreation. */
object BrowserRouting {
    private var revision=0
    private var busy=false
    private var pending: (() -> Unit)? = null
    fun apply(context:Context,config:ProxyConfig?,done:(Boolean)->Unit) {
        val current=++revision
        pending = {
            busy=true
            fun finish(success:Boolean) {
                busy=false
                if(current==revision) done(success)
                pump()
            }
            try {
                val complete=Runnable { finish(true) }
                if(!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) finish(config==null)
                else if(config==null) ProxyController.getInstance().clearProxyOverride(ContextCompat.getMainExecutor(context.applicationContext),complete)
                else ProxyController.getInstance().setProxyOverride(config,ContextCompat.getMainExecutor(context.applicationContext),complete)
            } catch(_:RuntimeException) { finish(false) }
        }
        pump()
    }
    private fun pump() {
        if(busy) return
        val action=pending ?: return
        pending=null
        action()
    }
}
