package com.germondai.trawl.mobile

import android.content.Context
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.os.Bundle
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import com.germondai.trawl.desktop.R
import org.json.JSONObject

/** Xiaomi's documented client integration; ordinary notifications remain the fallback. */
object FocusNotifications {
    @Volatile private var allowed=false
    private val xiaomi get()=Build.MANUFACTURER.lowercase() in setOf("xiaomi","redmi","poco")
    private fun query(context:Context):Boolean {
        if(!xiaomi) return false
        return try {
            context.contentResolver.call(Uri.parse("content://miui.statusbar.notification.public"),"canShowFocus",null,Bundle().apply { putString("package",context.packageName) })?.getBoolean("canShowFocus",false)==true
        } catch(_:Exception) { false }
    }
    fun refresh(context:Context,done:()->Unit={}) { Thread { allowed=query(context.applicationContext);done() }.start() }
    fun status(context:Context,invoke:Invoke) { refresh(context) {
        invoke.resolve(JSObject().apply {
            put("androidLiveUpdates",Build.VERSION.SDK_INT>=36)
            put("xiaomi",xiaomi)
            put("focusAllowed",allowed)
        })
    } }
    fun extras(context:Context,state:StateArgs,title:String):Bundle {
        if(!allowed) return Bundle()
        val key="miui.focus.pic_trawl"
        val picture=JSONObject().put("type",1).put("pic",key)
        val text=JSONObject().put("frontTitle","TRAWL").put("title",if(state.active>0) Localizations.text(context,"native.activeShort","count" to state.active) else if(state.running) Localizations.text(context,"native.online") else Localizations.text(context,"native.stopped")).put("content",Localizations.text(context,"native.requestShort","count" to state.requests)).put("useHighLight",false)
        val large=JSONObject().put("imageTextInfoLeft",JSONObject().put("type",1).put("picInfo",picture).put("textInfo",text)).put("picInfo",picture)
        val island=JSONObject().put("islandProperty",1).put("bigIslandArea",large).put("smallIslandArea",JSONObject().put("picInfo",picture))
        val params=JSONObject().put("protocol",1).put("business","trawl_server").put("enableFloat",false).put("updatable",true)
            .put("ticker",title.take(40)).put("tickerPic",key).put("aodTitle",title.take(60)).put("aodPic",key)
            .put("param_island",island).put("baseInfo",JSONObject().put("title",title.take(60)).put("content",Localizations.text(context,"native.activeSummary","requests" to state.requests,"active" to state.active)).put("type",2))
        val payload=JSONObject().put("param_v2",params).toString()
        if(payload.toByteArray(Charsets.UTF_8).size>3072) return Bundle()
        return Bundle().apply {
            putString("miui.focus.param",payload)
            putBundle("miui.focus.pics",Bundle().apply { putParcelable(key,Icon.createWithResource(context,R.drawable.trawl_mark)) })
        }
    }
}
