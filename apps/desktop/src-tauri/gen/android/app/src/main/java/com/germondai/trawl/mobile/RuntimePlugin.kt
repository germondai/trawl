package com.germondai.trawl.mobile

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Settings
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

@InvokeArg class StateArgs {
    var running: Boolean = false
    var active: Int = 0
    var requests: Long = 0
    var successes: Long = 0
    var failures: Long = 0
    var baseURL: String? = null
    var uptime: Long = 0
}
@InvokeArg class BrowserArgs { var url: String = ""; var requestId: String = ""; var maxTimeout: Long = 60000 }
@InvokeArg class IdArgs { var requestId: String = "" }
@InvokeArg class NoticeArgs { var title: String = "TRAWL"; var body: String = "" }

@TauriPlugin
class RuntimePlugin(private val activity: Activity) : Plugin(activity), DefaultLifecycleObserver {
    private val main = Handler(Looper.getMainLooper())
    init { main.post { ProcessLifecycleOwner.get().lifecycle.addObserver(this) } }
    override fun onStart(owner: LifecycleOwner) { RuntimeService.visible = true }
    override fun onStop(owner: LifecycleOwner) { RuntimeService.visible = false }
    private fun start() { ContextCompat.startForegroundService(activity, Intent(activity, RuntimeService::class.java)) }
    @Command fun ensureService(invoke: Invoke) { main.post { try { start(); invoke.resolve() } catch (e: Exception) { invoke.reject("Could not start background service: ${e.message}") } } }
    @Command fun setState(invoke: Invoke) {
        val state = invoke.parseArgs(StateArgs::class.java)
        main.post { RuntimeService.state = state; RuntimeService.instance?.update(); invoke.resolve() }
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
    @Command fun notifyTask(invoke: Invoke) { val value=invoke.parseArgs(NoticeArgs::class.java); main.post { RuntimeService.notifyTask(activity, value.title, value.body); invoke.resolve() } }
    @Command fun resources(invoke: Invoke) { main.post { invoke.resolve(RuntimeService.resources(activity)) } }
    @Command fun openUrl(invoke: Invoke) { val args=invoke.parseArgs(BrowserArgs::class.java); main.post { try { activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(args.url))); invoke.resolve() } catch(e:Exception) {invoke.reject("No application can open this URL")} } }
    @Command fun storageSettings(invoke: Invoke) { activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${activity.packageName}"))); invoke.resolve() }
    @Command fun minimize(invoke: Invoke) { activity.moveTaskToBack(true); invoke.resolve() }
    @Command fun shutdown(invoke: Invoke) { main.post { activity.stopService(Intent(activity, RuntimeService::class.java)); invoke.resolve() } }
}
