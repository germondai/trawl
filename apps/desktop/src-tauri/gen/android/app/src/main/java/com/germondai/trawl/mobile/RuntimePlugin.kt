package com.germondai.trawl.mobile

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.HapticFeedbackConstants
import androidx.core.content.ContextCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.DeserializationFeature
import java.lang.ref.WeakReference

@InvokeArg class StateArgs {
    var running: Boolean = false
    var active: Int = 0
    var requests: Long = 0
    var successes: Long = 0
    var failures: Long = 0
    var baseURL: String? = null
    var uptime: Long = 0
    var liveActivities: Boolean = true
    var language: String = "system"
}
@InvokeArg class BrowserArgs { var url: String = ""; var requestId: String = ""; var maxTimeout: Long = 60000; var proxyPort: Int = 0; var proxyToken: String = "" }
@InvokeArg class IdArgs { var requestId: String = "" }
@InvokeArg class NoticeArgs { var title: String = "TRAWL"; var body: String = "" }

@TauriPlugin
class RuntimePlugin(activity: Activity) : Plugin(activity), DefaultLifecycleObserver {
    companion object {
        private var instance: RuntimePlugin? = null
        fun attach(activity: Activity) { instance?.host = WeakReference(activity) }
    }
    private val context = activity.applicationContext
    private var host = WeakReference(activity)
    private val activity: Activity get() = host.get()?.takeUnless { it.isDestroyed } ?: throw IllegalStateException("Open TRAWL to perform this action")
    private val main = Handler(Looper.getMainLooper())
    private val runtime = RuntimeConnection(context)
    private val mapper = ObjectMapper().configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false)
    private external fun nativeReady()
    private external fun nativeReply(id: Int, success: Boolean, data: String)
    init { instance = this; nativeReady(); main.post { ProcessLifecycleOwner.get().lifecycle.addObserver(this) } }
    // Unlike Wry's dispatcher this bridge remains usable with no Activity.
    fun dispatch(id: Int, command: String, data: String) {
        main.post {
            val invoke = Invoke(id.toLong(), command, 0, 1, { callback, result -> nativeReply(id, callback == 0L, result) }, data, mapper)
            try {
                when(command) {
                    "runtime" -> runtime.call(invoke)
                    "ensureService" -> ensureService(invoke)
                    "setState" -> setState(invoke)
                    "serverIntent" -> { RuntimeService.setDesired(context,invoke.getArgs().optBoolean("running")); invoke.resolve() }
                    "browser" -> browser(invoke)
                    "cancelBrowser" -> cancelBrowser(invoke)
                    "notifyTask" -> notifyTask(invoke)
                    "resources" -> resources(invoke)
                    "openUrl" -> openUrl(invoke)
                    "storageSettings" -> storageSettings(invoke)
                    "minimize" -> minimize(invoke)
                    "interactionHaptic" -> {
                        val view = activity.window.decorView
                        val feedback = invoke.getArgs().optString("feedback")
                        val effect = if (Build.VERSION.SDK_INT >= 30 && feedback == "success") {
                            HapticFeedbackConstants.CONFIRM
                        } else if (Build.VERSION.SDK_INT >= 30 && feedback == "error") {
                            HapticFeedbackConstants.REJECT
                        } else {
                            HapticFeedbackConstants.VIRTUAL_KEY
                        }
                        if (view.hasWindowFocus()) view.performHapticFeedback(effect)
                        invoke.resolve()
                    }
                    "pageBack" -> {
                        (activity as com.germondai.trawl.desktop.MainActivity).setPageBackEnabled(invoke.getArgs().optBoolean("enabled"))
                        invoke.resolve()
                    }
                    "shutdown" -> shutdown(invoke)
                    "actionFeedback" -> { RuntimeService.instance?.actionFeedback(invoke.getArgs().optString("action"), invoke.getArgs().optBoolean("success")); invoke.resolve() }
                    "liveActivityStatus" -> FocusNotifications.status(context,invoke)
                    "appLocale" -> { RuntimeService.syncLanguage(context);invoke.resolve(JSObject().apply { put("locale",Localizations.locale()) }) }
                    else -> invoke.reject("Unknown Android service operation")
                }
            } catch(e: Exception) { invoke.reject(e.message ?: "Android service operation failed") }
        }
    }
    override fun onStart(owner: LifecycleOwner) { RuntimeService.visible = true }
    override fun onStop(owner: LifecycleOwner) { RuntimeService.visible = false }
    private fun start() { ContextCompat.startForegroundService(context, Intent(context, RuntimeService::class.java)) }
    @Command fun ensureService(invoke: Invoke) { main.post { try { start(); invoke.resolve() } catch (e: Exception) { invoke.reject("Could not start background service: ${e.message}") } } }
    @Command fun setState(invoke: Invoke) {
        val state = invoke.parseArgs(StateArgs::class.java)
        main.post { RuntimeService.setState(context,state); invoke.resolve() }
    }
    @Command fun browser(invoke: Invoke) {
        val args = invoke.parseArgs(BrowserArgs::class.java)
        main.post {
            if (args.url.length > 8192 || Uri.parse(args.url).scheme !in listOf("http", "https") || args.requestId.length > 80) { invoke.reject("Invalid browser request"); return@post }
            if (RuntimeService.queue.size >= 4) { invoke.reject("Android browser queue is full"); return@post }
            try { start(); RuntimeService.queue.add(BrowserWork(args, invoke)); RuntimeService.instance?.pump() }
            catch (e: Exception) { invoke.reject("Could not start browser renderer: ${e.message}") }
        }
    }
    @Command fun cancelBrowser(invoke: Invoke) { val id=invoke.parseArgs(IdArgs::class.java).requestId; main.post { RuntimeService.instance?.cancelBrowser(id); invoke.resolve() } }
    @Command fun notifyTask(invoke: Invoke) { val value=invoke.parseArgs(NoticeArgs::class.java); main.post { RuntimeService.notifyTask(context, value.title, value.body); invoke.resolve() } }
    @Command fun resources(invoke: Invoke) { main.post { invoke.resolve(RuntimeService.resources(context)) } }
    @Command fun openUrl(invoke: Invoke) { val args=invoke.parseArgs(BrowserArgs::class.java); main.post { try { activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(args.url))); invoke.resolve() } catch(e:Exception) {invoke.reject("No application can open this URL")} } }
    @Command fun storageSettings(invoke: Invoke) { activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${activity.packageName}"))); invoke.resolve() }
    @Command fun minimize(invoke: Invoke) { activity.moveTaskToBack(true); invoke.resolve() }
    @Command fun shutdown(invoke: Invoke) { main.post { runtime.stop(); invoke.resolve() } }
}
