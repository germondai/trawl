package com.germondai.trawl.mobile

import android.Manifest
import android.app.*
import android.content.*
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.*
import android.webkit.*
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.util.ArrayDeque
import kotlin.math.max

class BrowserWork(val args: BrowserArgs, val invoke: Invoke)

class RuntimeService : Service() {
    companion object {
        @Volatile var instance: RuntimeService? = null
        @Volatile var visible = true
        var state = StateArgs()
        val queue = ArrayDeque<BrowserWork>()
        private const val LIVE_ID = 8191
        private const val LIVE_CHANNEL = "trawl-server"
        private const val TASK_CHANNEL = "trawl-tasks"
        private var nextNotice = 9000
        private fun channels(context: Context) {
            if (Build.VERSION.SDK_INT >= 26) {
                val manager = context.getSystemService(NotificationManager::class.java)
                manager.createNotificationChannel(NotificationChannel(LIVE_CHANNEL, "Running server and tasks", NotificationManager.IMPORTANCE_LOW))
                manager.createNotificationChannel(NotificationChannel(TASK_CHANNEL, "Completed background tasks", NotificationManager.IMPORTANCE_DEFAULT))
            }
        }
        private fun open(context: Context): PendingIntent = PendingIntent.getActivity(context, 0, context.packageManager.getLaunchIntentForPackage(context.packageName)!!.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        fun notifyTask(context: Context, title: String, body: String) {
            if (visible || (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)) return
            channels(context)
            val notice = NotificationCompat.Builder(context, TASK_CHANNEL).setSmallIcon(android.R.drawable.stat_notify_sync_noanim).setContentTitle(title.take(160)).setContentText(body.take(300)).setContentIntent(open(context)).setAutoCancel(true).build()
            context.getSystemService(NotificationManager::class.java).notify(nextNotice++, notice)
            // Bound notifications rather than accumulating one for every completed request.
            if (nextNotice > 9005) nextNotice = 9000
        }
        fun resources(context: Context): JSObject {
            val manager = context.getSystemService(ActivityManager::class.java)
            val memory = ActivityManager.MemoryInfo(); manager.getMemoryInfo(memory)
            val process = Debug.MemoryInfo(); Debug.getMemoryInfo(process)
            val files = java.io.File(context.applicationInfo.dataDir)
            fun size(file: java.io.File): Long = if (file.isFile) file.length() else 0
            val result=JSObject()
            result.put("sampledAt", System.currentTimeMillis()); result.put("cpuPercent", JSONObject.NULL); result.put("logicalCpus", Runtime.getRuntime().availableProcessors()); result.put("memoryBytes", process.totalPss.toLong()*1024)
            result.put("hostMemory", JSONObject().put("totalBytes", memory.totalMem).put("availableBytes", memory.availMem))
            result.put("processes", JSONArray().put(JSONObject().put("pid", Process.myPid()).put("name", "TRAWL app").put("memoryBytes",process.totalPss.toLong()*1024).put("cpuPercent", JSONObject.NULL)))
            val entries=JSONArray()
            for ((label,name) in listOf("Configuration" to "config.json", "Metrics" to "history.json")) entries.put(JSONObject().put("name",label).put("bytes",size(java.io.File(files,name))).put("partial",false))
            result.put("disk",JSONObject().put("entries",entries)); return result
        }
    }
    private val main=Handler(Looper.getMainLooper())
    private var current: BrowserWork? = null
    private var web: WebView? = null
    private var deadline=0L
    private var pageStatus=200
    private var stopped=false
    private external fun nativeAction(action: String): Boolean
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onCreate() {
        super.onCreate(); instance=this; channels(this)
        val notice=notification()
        if (Build.VERSION.SDK_INT >= 34) startForeground(LIVE_ID,notice,ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE) else startForeground(LIVE_ID,notice)
        pump()
    }
    private fun action(name: String): PendingIntent = PendingIntent.getService(this, name.hashCode(), Intent(this,RuntimeService::class.java).setAction(name),PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    private fun notification(): Notification {
        val builder=NotificationCompat.Builder(this,LIVE_CHANNEL).setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
            .setContentTitle(if(state.running) "TRAWL server active" else "TRAWL background task")
            .setContentText(if(state.running) "${state.requests} requests · ${state.successes} successful · ${state.failures} failed" else "Finishing active work…")
            .setSubText(state.baseURL).setOngoing(true).setOnlyAlertOnce(true).setContentIntent(open(this)).setDeleteIntent(action("restore"))
        if(state.running) builder.addAction(android.R.drawable.ic_media_pause,"Stop",action("stop")).addAction(android.R.drawable.ic_popup_sync,"Restart",action("restart"))
        return builder.build()
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when(intent?.action) {
            "stop", "restart" -> if(!nativeAction(intent.action!!)) { state.running=false; update() }
            "restore" -> main.postDelayed({ if(!stopped && (state.running || state.active>0 || current!=null || queue.isNotEmpty())) update() },500)
        }
        update(); return START_NOT_STICKY
    }
    fun update() {
        if(stopped) return
        if(state.running || state.active>0 || current!=null || queue.isNotEmpty()) getSystemService(NotificationManager::class.java).notify(LIVE_ID,notification())
        else { main.postDelayed({ if(!state.running && state.active==0 && current==null && queue.isEmpty()) {stopForeground(STOP_FOREGROUND_REMOVE);stopSelf()} },1000) }
    }
    fun pump() {
        if(current!=null || queue.isEmpty() || stopped) return
        val work=queue.removeFirst();current=work; deadline=SystemClock.elapsedRealtime()+work.args.maxTimeout.coerceIn(1,180000);pageStatus=200
        CookieManager.getInstance().removeAllCookies {
            if(current!==work) return@removeAllCookies
            try {
                val view=WebView(this);web=view
                view.settings.javaScriptEnabled=true;view.settings.domStorageEnabled=true
                view.settings.allowFileAccess=false;view.settings.allowContentAccess=false
                view.settings.mixedContentMode=WebSettings.MIXED_CONTENT_NEVER_ALLOW
                view.settings.javaScriptCanOpenWindowsAutomatically=false;view.settings.setSupportMultipleWindows(false);view.settings.setGeolocationEnabled(false)
                if(Build.VERSION.SDK_INT>=26) view.settings.safeBrowsingEnabled=true
                view.setDownloadListener { _,_,_,_,_-> if(current===work) fail("Use HTTP mode for files; browser file downloads are unavailable") }
                view.webViewClient=object:WebViewClient() {
                    override fun shouldOverrideUrlLoading(view:WebView,request:WebResourceRequest):Boolean = request.url.scheme !in listOf("http","https")
                    override fun onPageFinished(view:WebView,url:String) { main.postDelayed({collect(work)},1500) }
                    override fun onReceivedHttpError(view:WebView,request:WebResourceRequest,error:WebResourceResponse) {if(current===work && request.isForMainFrame) pageStatus=error.statusCode}
                    override fun onReceivedError(view:WebView,request:WebResourceRequest,error:WebResourceError) {if(current===work && request.isForMainFrame) fail("Browser navigation failed: ${error.description}")}
                    override fun onReceivedSslError(view:WebView,handler:SslErrorHandler,error:SslError) {handler.cancel();if(current===work)fail("TLS certificate verification failed")}
                    override fun onRenderProcessGone(view:WebView,detail:RenderProcessGoneDetail):Boolean {if(current===work)fail("Android stopped the browser renderer");return true}
                }
                view.onResume();view.resumeTimers();view.loadUrl(work.args.url);main.postDelayed({checkDeadline(work)},250)
            } catch(e:Exception) {fail("Could not create Android WebView: ${e.message}")}
        }
        update()
    }
    private fun checkDeadline(work:BrowserWork) {if(current!==work)return;if(SystemClock.elapsedRealtime()>=deadline)fail("Browser request timed out")else main.postDelayed({checkDeadline(work)},250)}
    private fun collect(work:BrowserWork) {
        if(current!==work)return
        web?.evaluateJavascript("JSON.stringify({url:location.href,html:document.documentElement?document.documentElement.outerHTML:'',userAgent:navigator.userAgent})") { raw ->
            if(current!==work)return@evaluateJavascript
            try {
                val encoded=JSONTokener(raw).nextValue() as? String ?: throw IllegalStateException("No browser document")
                val data=JSONObject(encoded); val html=data.getString("html")
                if(html.toByteArray(Charsets.UTF_8).size>4*1024*1024) {fail("Browser response exceeds 4 MiB");return@evaluateJavascript}
                if(listOf("cf-chl-","Just a moment...").any{html.contains(it)}) {
                    if(SystemClock.elapsedRealtime()+500<deadline) main.postDelayed({collect(work)},500) else fail("The Android browser could not solve the challenge before the deadline")
                    return@evaluateJavascript
                }
                val url=data.getString("url"); val cookies=JSONArray(); val domain=Uri.parse(url).host ?: ""
                for(part in (CookieManager.getInstance().getCookie(url) ?: "").split(';').take(200)) {
                    val pair=part.trim().split('=',limit=2);if(pair.size==2) cookies.put(JSONObject().put("name",pair[0]).put("value",pair[1]).put("domain",domain).put("path","/").put("expires",-1).put("httpOnly",false).put("secure",url.startsWith("https:")))
                }
                val response=JSObject();response.put("url",url);response.put("html",html);response.put("cookies",cookies);response.put("userAgent",data.getString("userAgent"));response.put("statusCode",pageStatus);response.put("responseHeaders",JSONObject().put("content-type","text/html"));response.put("contentType","text/html")
                work.invoke.resolve(response);finish()
            } catch(e:Exception) {fail("Could not read browser document: ${e.message}")}
        }
    }
    fun cancelBrowser(id:String) {if(current?.args?.requestId==id)fail("Browser request cancelled")else {val iterator=queue.iterator();while(iterator.hasNext()){val work=iterator.next();if(work.args.requestId==id){iterator.remove();work.invoke.reject("Browser request cancelled")}}}}
    private fun fail(reason:String) {current?.invoke?.reject(reason);finish()}
    private fun finish() {web?.stopLoading();web?.loadUrl("about:blank");web?.destroy();web=null;current=null;CookieManager.getInstance().removeAllCookies(null);pump();update()}
    override fun onDestroy() {stopped=true;main.removeCallbacksAndMessages(null);current?.invoke?.reject("Background service stopped");current=null;while(queue.isNotEmpty())queue.removeFirst().invoke.reject("Background service stopped");web?.destroy();web=null;instance=null;super.onDestroy()}
}
