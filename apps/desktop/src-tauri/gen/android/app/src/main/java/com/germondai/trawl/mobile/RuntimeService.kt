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
import androidx.webkit.ProxyConfig
import androidx.webkit.WebViewFeature
import app.tauri.plugin.Invoke
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.DeserializationFeature
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
        @Volatile var visible = false
        var state = StateArgs()
        val queue = ArrayDeque<BrowserWork>()
        private const val LIVE_ID = 8191
        private const val LIVE_CHANNEL = "trawl-server"
        private const val TASK_CHANNEL = "trawl-tasks"
        private var nextNotice = 9000
        private var webViewConfigured = false
        private fun channels(context: Context) {
            if (Build.VERSION.SDK_INT >= 26) {
                val manager = context.getSystemService(NotificationManager::class.java)
                manager.createNotificationChannel(NotificationChannel(LIVE_CHANNEL, Localizations.text(context,"native.runningChannel"), NotificationManager.IMPORTANCE_LOW))
                manager.createNotificationChannel(NotificationChannel(TASK_CHANNEL, Localizations.text(context,"native.completedChannel"), NotificationManager.IMPORTANCE_DEFAULT))
            }
        }
        private fun open(context: Context): PendingIntent = PendingIntent.getActivity(context, 0, context.packageManager.getLaunchIntentForPackage(context.packageName)!!.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        fun notifyTask(context: Context, title: String, body: String) {
            if (visible || (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)) return
            syncLanguage(context)
            channels(context)
            val notice = NotificationCompat.Builder(context, TASK_CHANNEL).setSmallIcon(android.R.drawable.stat_notify_sync_noanim).setContentTitle(Localizations.text(context,title).take(160)).setContentText(Localizations.text(context,body).take(300)).setContentIntent(open(context)).setAutoCancel(true).build()
            context.getSystemService(NotificationManager::class.java).notify(nextNotice++, notice)
            // Bound notifications rather than accumulating one for every completed request.
            if (nextNotice > 9005) nextNotice = 9000
        }
        private fun preferences(context:Context) = context.getSharedPreferences("trawl-runtime",Context.MODE_PRIVATE)
        fun syncLanguage(context:Context) { Localizations.setLanguage(initialLanguage(context)) }
        private fun initialLiveActivities(context:Context):Boolean = try {
            val file=java.io.File(context.applicationInfo.dataDir,"config.json")
            val info=android.system.Os.lstat(file.path)
            // Match the native configuration reader's regular-file and 1 MiB limits.
            if(!android.system.OsConstants.S_ISREG(info.st_mode) || info.st_size !in 1L..1048576L) true
            else JSONObject(file.readText()).optJSONObject("desktop")?.optBoolean("liveActivities",true) ?: true
        } catch(_:Exception) { true }
        private fun initialLanguage(context:Context):String = try {
            val file=java.io.File(context.applicationInfo.dataDir,"config.json")
            val info=android.system.Os.lstat(file.path)
            if(!android.system.OsConstants.S_ISREG(info.st_mode) || info.st_size !in 1L..1048576L) "system"
            else JSONObject(file.readText()).optJSONObject("desktop")?.optString("language","system") ?: "system"
        } catch(_:Exception) { "system" }
        fun wanted(context:Context) = preferences(context).getBoolean("server-wanted",false)
        fun setDesired(context:Context,running:Boolean) { check(preferences(context).edit().putBoolean("server-wanted",running).commit()) { "Could not save background server state" } }
        fun setState(context:Context,next:StateArgs) {
            val activityChanged=state.liveActivities!=next.liveActivities
            val languageChanged=state.language!=next.language
            Localizations.setLanguage(next.language)
            if(languageChanged) channels(context)
            state=next
            instance?.apply { restoring=false; if(activityChanged && foregroundActive && !actionPending) resetNotification() else update() }
        }
        fun backgroundStatus(context:Context):JSONObject {
            val result=JSONObject().put("wanted",wanted(context))
            if(Build.VERSION.SDK_INT>=30) {
                val exit=context.getSystemService(ActivityManager::class.java).getHistoricalProcessExitReasons(context.packageName,0,1).firstOrNull()
                if(exit!=null) {
                    val reason=when(exit.reason) {
                        ApplicationExitInfo.REASON_LOW_MEMORY -> "Android reclaimed memory"
                        ApplicationExitInfo.REASON_CRASH,ApplicationExitInfo.REASON_CRASH_NATIVE -> "Application crash"
                        ApplicationExitInfo.REASON_ANR -> "Application stopped responding"
                        ApplicationExitInfo.REASON_USER_REQUESTED -> "Stopped by the user or device app manager"
                        ApplicationExitInfo.REASON_USER_STOPPED -> "Application was force-stopped"
                        ApplicationExitInfo.REASON_SIGNALED -> "Process killed by signal ${exit.status}${when(exit.status) {9->" (SIGKILL)";15->" (SIGTERM)";6->" (SIGABRT)";11->" (SIGSEGV)";else->""}}"
                        ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "Android resource limit"
                        ApplicationExitInfo.REASON_PACKAGE_UPDATED -> "Application update"
                        else -> "Android process exit (reason ${exit.reason})"
                    }
                    result.put("reason",reason).put("at",exit.timestamp).put("process",if(exit.processName.endsWith(":runtime")) "Server" else "Interface")
                }
            }
            return result
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
            result.put("disk",JSONObject().put("entries",entries)); result.put("background",backgroundStatus(context)); return result
        }
    }
    private val main=Handler(Looper.getMainLooper())
    private var current: BrowserWork? = null
    private var web: WebView? = null
    private var deadline=0L
    private var pageStatus=200
    private var stopped=false
    private var restoring=true
    private var lastNotification: String? = null
    private var actionMessage: String? = null
    private var actionPending = false
    private var actionRevision = 0
    private var notificationId = LIVE_ID
    private var proxyActive = false
    private var clearingProxy = false
    private var foregroundActive = false
    private var nextControl = 0
    private data class Control(val client:Messenger,val id:Int)
    private val controls=mutableMapOf<Int,Control>()
    private val clients=mutableSetOf<IBinder>()
    private val messenger=Messenger(Handler(Looper.getMainLooper()) { message ->
        if(message.what==1 && message.sendingUid==applicationInfo.uid) {
            val client=message.replyTo
            val request=message.data.getString("request")
            if(client!=null && request!=null && request.toByteArray(Charsets.UTF_8).size<=384*1024 && controls.size<16) {
                if(clients.add(client.binder)) {
                    try { client.binder.linkToDeath({ main.post {
                        clients.remove(client.binder)
                        controls.entries.removeAll { it.value.client.binder==client.binder }
                        nativeManagement(0,"{\"action\":\"clientJobs\",\"active\":0}")
                    } },0) } catch(_:RemoteException) { clients.remove(client.binder) }
                }
                val id=++nextControl
                controls[id]=Control(client,message.arg1)
                nativeManagement(id,request)
                main.postDelayed({ replyControl(id,false,"{}","Background runtime request timed out") },8500)
            }
        }
        true
    })
    private fun replyControl(id:Int,ok:Boolean,data:String,error:String="") {
        val control=controls.remove(id) ?: return
        val bounded=data.toByteArray(Charsets.UTF_8).size<=384*1024
        try { control.client.send(Message.obtain(null,2,control.id,0).apply {
            this.data=Bundle().apply { putBoolean("ok",ok && bounded);putString("data",if(bounded)data else "{}");putString("error",if(bounded)error else "Background response exceeds its limit") }
        }) } catch(_:RemoteException) {}
    }
    private external fun nativeAction(action: String): Boolean
    private external fun nativeReady()
    private external fun nativeRelease()
    private external fun nativeRestore(home:String,wanted:Boolean)
    private external fun nativeManagement(id:Int,request:String)
    private external fun nativeReply(id:Int,success:Boolean,data:String)
    private val mapper=ObjectMapper().configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES,false)
    fun dispatch(id:Int,command:String,data:String) {
        main.post {
            val invoke=Invoke(id.toLong(),command,0,1,{ callback,result -> nativeReply(id,callback==0L,result) },data,mapper)
            try {
                check(!stopped) { "Background service stopped" }
                when(command) {
                    "ensureService" -> invoke.resolve()
                    "resources" -> invoke.resolve(resources(this))
                    "notifyTask" -> { val args=invoke.parseArgs(NoticeArgs::class.java);notifyTask(this,args.title,args.body);invoke.resolve() }
                    "runtimeReply" -> { val args=invoke.getArgs();replyControl(args.optInt("id"),args.optBoolean("ok"),JSONObject().put("value",args.opt("value")).toString(),args.optString("message"));invoke.resolve() }
                    "setState" -> { setState(this,invoke.parseArgs(StateArgs::class.java)); invoke.resolve() }
                    "serverIntent" -> { setDesired(this,invoke.getArgs().optBoolean("running")); invoke.resolve() }
                    "browser" -> {
                        val args=invoke.parseArgs(BrowserArgs::class.java)
                        require(args.url.length<=8192 && Uri.parse(args.url).scheme in listOf("http","https") && args.requestId.length<=80) { "Invalid browser request" }
                        require(queue.size<4) { "Android browser queue is full" }
                        queue.add(BrowserWork(args,invoke)); pump()
                    }
                    "cancelBrowser" -> { cancelBrowser(invoke.parseArgs(IdArgs::class.java).requestId); invoke.resolve() }
                    "actionFeedback" -> { actionFeedback(invoke.getArgs().optString("action"),invoke.getArgs().optBoolean("success")); invoke.resolve() }
                    "runtimeFailure" -> { restoring=false; actionMessage="native.restoreFailed"; actionPending=false; update(); main.postDelayed({ actionMessage=null; update() },5000); invoke.resolve() }
                    else -> invoke.reject("Background operation is unavailable")
                }
            } catch(e:Exception) { invoke.reject(e.message ?: "Background operation failed") }
        }
    }
    override fun onBind(intent: Intent?): IBinder = messenger.binder
    override fun onCreate() {
        super.onCreate(); instance=this
        state.language=initialLanguage(this)
        Localizations.setLanguage(state.language)
        channels(this)
        state.liveActivities=initialLiveActivities(this)
        if(!webViewConfigured) {
            if(Build.VERSION.SDK_INT>=28) WebView.setDataDirectorySuffix("runtime")
            webViewConfigured=true
        }
        System.loadLibrary("trawl_desktop")
        nativeReady()
        val wanted=wanted(this)
        if(wanted) {
            foreground(notification())
            // A restored server must outlive the UI's Binder connection, including its initial bind.
            ContextCompat.startForegroundService(this,Intent(this,RuntimeService::class.java))
        }
        nativeRestore(applicationInfo.dataDir,wanted)
        pump()
        FocusNotifications.refresh(this) { main.post { lastNotification=null; update() } }
    }
    private fun foreground(notice:Notification,id:Int=notificationId) {
        if (Build.VERSION.SDK_INT >= 34) startForeground(id,notice,ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE) else startForeground(id,notice)
        notificationId=id
        foregroundActive=true
    }
    private fun resetNotification() {
        val previous=notificationId
        // Recreate the notice without dropping foreground priority while the UI is closed.
        foreground(notification(),if(previous==LIVE_ID) LIVE_ID+1 else LIVE_ID)
        getSystemService(NotificationManager::class.java).cancel(previous)
        lastNotification=null
        update()
    }
    private fun action(name: String): PendingIntent = PendingIntent.getService(this, name.hashCode(), Intent(this,RuntimeService::class.java).setAction(name),PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    private fun notification(): Notification {
        val text=if(actionPending) Localizations.text(this,"native.pleaseWait") else if(state.running) Localizations.text(this,"native.requestSummary","requests" to state.requests,"successes" to state.successes,"failures" to state.failures) else if(actionMessage!=null) Localizations.text(this,"native.serverStopped") else Localizations.text(this,"native.finishingWork")
        val builder=NotificationCompat.Builder(this,LIVE_CHANNEL).setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
            .setContentTitle(Localizations.text(this,actionMessage ?: if(state.running) "native.serverActive" else "native.backgroundTask"))
            .setContentText(text).setColorized(false)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setSubText(state.baseURL).setOngoing(true).setOnlyAlertOnce(true).setContentIntent(open(this)).setDeleteIntent(action("restore"))
        if(actionPending) builder.setProgress(0,0,true)
        if(state.running && !actionPending) builder.addAction(android.R.drawable.ic_media_pause,Localizations.text(this,"ui.stop"),action("stop")).addAction(android.R.drawable.ic_popup_sync,Localizations.text(this,"ui.restart"),action("restart"))
        builder.setCategory(NotificationCompat.CATEGORY_PROGRESS)
        if(state.liveActivities) {
            builder.addExtras(Bundle().apply { putBoolean("android.requestPromotedOngoing", true) })
            builder.addExtras(FocusNotifications.extras(this,state,Localizations.text(this,actionMessage ?: "native.serverActive")))
        }
        val notice=builder.build()
        return if(Build.VERSION.SDK_INT>=36) Notification.Builder.recoverBuilder(this,notice).setShortCriticalText(if(actionPending) Localizations.text(this,"native.wait") else if(state.active>0) Localizations.text(this,"native.activeShort","count" to state.active) else if(state.running) Localizations.text(this,"native.running") else Localizations.text(this,"native.stopped")).build() else notice
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if(!foregroundActive) foreground(notification())
        when(intent?.action) {
            "stop", "restart" -> if(!actionPending) {
                actionPending=true
                actionMessage=if(intent.action=="restart") null else "native.stopping"
                update()
                if(!nativeAction(intent.action!!)) actionFeedback(intent.action!!,false)
            }
            "restore" -> main.postDelayed({ if(!stopped && (state.running || state.active>0 || current!=null || queue.isNotEmpty())) { lastNotification=null; update() } },500)
        }
        update(); return START_STICKY
    }
    fun update() {
        if(stopped) return
        if(actionPending && actionMessage==null) return // Keep the previous notice until restart finishes.
        if(!foregroundActive && !state.running && state.active==0 && current==null && queue.isEmpty()) return
        if(restoring || state.running || state.active>0 || current!=null || queue.isNotEmpty() || actionPending || actionMessage!=null) {
            val key="${state.running}:${state.active}:${state.requests}:${state.successes}:${state.failures}:${state.baseURL}:${state.liveActivities}:${Localizations.locale()}:$actionMessage"
            if(key!=lastNotification) { lastNotification=key; getSystemService(NotificationManager::class.java).notify(notificationId,notification()) }
        }
        else { main.postDelayed({ if(!restoring && !state.running && state.active==0 && current==null && queue.isEmpty() && !actionPending && actionMessage==null) {stopForeground(STOP_FOREGROUND_REMOVE);foregroundActive=false;stopSelf()} },1000) }
    }
    fun actionFeedback(action:String, success:Boolean) {
        actionPending=false
        actionMessage=if(success) { if(action=="restart") null else "native.stoppedTitle" } else "native.actionFailed"
        val revision=++actionRevision
        if(success && action=="restart") resetNotification() else update()
        main.postDelayed({ if(actionRevision==revision) { actionMessage=null; update() } },3500)
    }
    override fun onTaskRemoved(rootIntent: Intent?) {
        visible = false
        update()
        super.onTaskRemoved(rootIntent)
    }
    override fun onConfigurationChanged(configuration: android.content.res.Configuration) {
        super.onConfigurationChanged(configuration)
        if(state.language=="system") { channels(this);lastNotification=null;update() }
    }
    fun pump() {
        if(current!=null || clearingProxy || queue.isEmpty() || stopped) return
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
                    override fun onReceivedHttpAuthRequest(view:WebView,handler:HttpAuthHandler,host:String,realm:String) {
                        if(current===work && work.args.proxyPort>0 && host=="127.0.0.2" && realm=="TRAWL-DNS") handler.proceed("trawl",work.args.proxyToken) else handler.cancel()
                    }
                    override fun onRenderProcessGone(view:WebView,detail:RenderProcessGoneDetail):Boolean {if(current===work)fail("Android stopped the browser renderer");return true}
                }
                val load: (Boolean)->Unit = { success -> if(current===work) {
                    if(!success) fail("Could not apply instance DNS routing")
                    else try { view.onResume();view.resumeTimers();view.loadUrl(work.args.url) } catch(_:RuntimeException) { fail("Browser navigation could not start") }
                } }
                if(work.args.proxyPort>0) {
                    require((getSystemService(android.net.ConnectivityManager::class.java)).defaultProxy == null) { "Instance DNS rendering cannot replace a device HTTP/PAC proxy. Select system DNS or remove that proxy." }
                    require(work.args.proxyPort in 1..65535 && work.args.proxyToken.matches(Regex("[a-f0-9]{32}"))) { "Invalid instance DNS forwarder" }
                    require(WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) { "This Android WebView cannot use instance DNS. Update Android System WebView or select system DNS." }
                    proxyActive=true
                    val proxy=ProxyConfig.Builder().addProxyRule("http://127.0.0.2:${work.args.proxyPort}").removeImplicitRules()
                        .addBypassRule("tauri.localhost").addBypassRule("*.tauri.localhost").addBypassRule("ipc.localhost").build()
                    BrowserRouting.apply(this,proxy,load)
                } else BrowserRouting.apply(this,null,load)
                main.postDelayed({checkDeadline(work)},250)
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
    private fun finish() {
        web?.stopLoading();web?.loadUrl("about:blank");web?.destroy();web=null;current=null;CookieManager.getInstance().removeAllCookies(null)
        if(proxyActive) {
            proxyActive=false;clearingProxy=true
            BrowserRouting.apply(this,null) { success -> if(!stopped && instance===this) {
                clearingProxy=false
                if(success) pump() else while(queue.isNotEmpty()) queue.removeFirst().invoke.reject("Could not reset browser routing; reopen TRAWL")
                update()
            } }
        } else {pump();update()}
    }
    override fun onDestroy() {stopped=true;main.removeCallbacksAndMessages(null);current?.invoke?.reject("Background service stopped");current=null;while(queue.isNotEmpty())queue.removeFirst().invoke.reject("Background service stopped");web?.destroy();web=null;if(proxyActive || clearingProxy) BrowserRouting.apply(this,null) {};proxyActive=false;instance=null;nativeRelease();super.onDestroy()}
}
