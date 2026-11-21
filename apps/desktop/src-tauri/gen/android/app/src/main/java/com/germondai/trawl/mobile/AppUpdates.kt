package com.germondai.trawl.mobile

import android.app.Activity
import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import androidx.core.content.FileProvider
import app.tauri.plugin.JSObject
import java.io.File
import java.security.MessageDigest

object AppUpdates {
    private fun prefs(context:Context)=context.getSharedPreferences("app-updates",Context.MODE_PRIVATE)
    private fun manager(context:Context)=context.getSystemService(DownloadManager::class.java)
    private fun file(context:Context)=File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS),"updates/TRAWL-update.apk")
    private fun result(state:String)=JSObject().apply { put("state",state) }
    @Suppress("DEPRECATION")
    private fun current(context:Context)=context.packageManager.getPackageInfo(context.packageName,0)
    @Suppress("DEPRECATION")
    private fun code(info:android.content.pm.PackageInfo)=if(Build.VERSION.SDK_INT>=28) info.longVersionCode else info.versionCode.toLong()
    private fun clear(context:Context) {
        val id=prefs(context).getLong("id",-1)
        if(id>=0) manager(context).remove(id)
        file(context).delete()
        prefs(context).edit().clear().apply()
    }
    fun status(context:Context):JSObject {
        val stored=prefs(context);val id=stored.getLong("id",-1)
        if(id<0) return result("idle")
        if(stored.getLong("installedVersion",-1)!=code(current(context))) { clear(context);return result("idle") }
        val query=manager(context).query(DownloadManager.Query().setFilterById(id)) ?: return result("failed")
        query.use { cursor ->
            if(!cursor.moveToFirst()) { clear(context);return result("idle") }
            val state=cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
            val value=result(when(state){DownloadManager.STATUS_SUCCESSFUL->"ready";DownloadManager.STATUS_FAILED->"failed";else->"downloading"})
            value.put("downloaded",cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)))
            value.put("total",cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)))
            return value
        }
    }
    @Suppress("DEPRECATION")
    private fun verify(context:Context) {
        RuntimeService.syncLanguage(context)
        val apk=file(context)
        require(apk.isFile && apk.length() in 1..180L*1024*1024) { "native.updateSize" }
        val flags=if(Build.VERSION.SDK_INT>=28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        val installed=context.packageManager.getPackageInfo(context.packageName,flags)
        val update=context.packageManager.getPackageArchiveInfo(apk.absolutePath,flags) ?: error("native.updatePackage")
        require(update.packageName==context.packageName && code(update)>code(installed)) { "native.updateVersion" }
        fun signatures(info:android.content.pm.PackageInfo)=if(Build.VERSION.SDK_INT>=28) info.signingInfo?.apkContentsSigners else info.signatures
        fun fingerprints(info:android.content.pm.PackageInfo)=signatures(info)?.map { MessageDigest.getInstance("SHA-256").digest(it.toByteArray()).toList() }?.toSet()
        val trusted=fingerprints(installed)
        require(!trusted.isNullOrEmpty() && trusted==fingerprints(update)) { "native.updateSignature" }
    }
    fun prepare(activity:Activity,url:String):JSObject {
        RuntimeService.syncLanguage(activity)
        val status=status(activity)
        if(status.optString("state")=="downloading") return status
        if(status.optString("state")=="ready") {
            try { verify(activity) } catch(e:Exception) { clear(activity);throw e }
            if(Build.VERSION.SDK_INT>=26 && !activity.packageManager.canRequestPackageInstalls()) {
                activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:${activity.packageName}")))
                return result("permission")
            }
            val uri=FileProvider.getUriForFile(activity,"${activity.packageName}.fileprovider",file(activity))
            activity.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri,"application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
            return result("ready")
        }
        val uri=Uri.parse(url)
        require(uri.scheme=="https" && uri.host=="github.com" && uri.path?.startsWith("/germondai/trawl/releases/download/")==true && uri.path?.endsWith(".apk")==true && uri.userInfo==null && uri.query==null && uri.fragment==null) { "native.checkAndroidUpdate" }
        clear(activity);file(activity).parentFile?.mkdirs()
        val request=DownloadManager.Request(uri).setTitle(Localizations.text(activity,"native.updateTitle")).setDescription(Localizations.text(activity,"native.updateDownloading")).setMimeType("application/vnd.android.package-archive")
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setDestinationInExternalFilesDir(activity,Environment.DIRECTORY_DOWNLOADS,"updates/TRAWL-update.apk")
        val id=manager(activity).enqueue(request)
        prefs(activity).edit().putLong("id",id).putLong("installedVersion",code(current(activity))).apply()
        return status(activity)
    }
    fun completed(context:Context,id:Long) {
        if(id!=prefs(context).getLong("id",-1)) return
        try {
            when(status(context).optString("state")) {
                "ready" -> { verify(context);RuntimeService.notifyTask(context,"ui.trawlUpdateDownloaded","ui.openAppSettingsToInstallTheVerifiedApk") }
                "failed" -> RuntimeService.notifyTask(context,"native.updateFailed","native.updateRetry")
            }
        }
        catch(e:Exception) { clear(context);RuntimeService.notifyTask(context,"native.updateRejected",e.message ?: "native.invalidApk") }
    }
}

class UpdateReceiver:BroadcastReceiver() {
    override fun onReceive(context:Context,intent:Intent) {
        if(intent.action!=DownloadManager.ACTION_DOWNLOAD_COMPLETE) return
        val pending=goAsync()
        Thread { try { AppUpdates.completed(context.applicationContext,intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID,-1)) } catch(_:Exception) { /* A receiver failure must not terminate a running server. */ } finally { pending.finish() } }.start()
    }
}
