package com.germondai.trawl.mobile

import android.content.*
import android.os.*
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject

/** Private Binder transport; only the service process owns the server and configuration. */
class RuntimeConnection(private val context: Context) : ServiceConnection {
    private val main=Handler(Looper.getMainLooper())
    private var remote:Messenger?=null
    private var binding=false
    private var next=0
    private data class Request(val invoke:Invoke,val data:String)
    private val pending=mutableMapOf<Int,Request>()
    private val replies=Messenger(Handler(Looper.getMainLooper()) { message ->
        val request=pending.remove(message.arg1)
        if(request!=null) {
            if(message.data.getBoolean("ok")) request.invoke.resolve(JSObject(message.data.getString("data","{}")))
            else request.invoke.reject(message.data.getString("error","Background service request failed"))
        }
        true
    })
    fun call(invoke:Invoke) {
        val data=invoke.getArgs().toString()
        if(data.toByteArray(Charsets.UTF_8).size>384*1024 || pending.size>=16) { invoke.reject("Background request exceeds its limit");return }
        val id=++next
        pending[id]=Request(invoke,data)
        main.postDelayed({ pending.remove(id)?.invoke?.reject("Background service reply timed out") },9000)
        if(remote!=null) send(id)
        else if(!binding) {
            binding=true
            try {
                if(!context.bindService(Intent(context,RuntimeService::class.java),this,Context.BIND_AUTO_CREATE)) disconnected()
            } catch(_:Exception) { disconnected() }
        }
    }
    private fun send(id:Int) {
        val request=pending[id] ?: return
        try {
            remote?.send(Message.obtain(null,1,id,0).apply {
                replyTo=replies
                data=Bundle().apply { putString("request",request.data) }
            })
        } catch(_:RemoteException) { disconnected() }
    }
    private fun disconnected() {
        remote=null
        if(binding) { try {context.unbindService(this)} catch(_:IllegalArgumentException) {};binding=false }
        val requests=pending.values.toList();pending.clear()
        requests.forEach {it.invoke.reject("Background service disconnected; retry the action")}
    }
    override fun onServiceConnected(name:ComponentName,binder:IBinder) {
        remote=Messenger(binder)
        pending.keys.toList().forEach(::send)
    }
    override fun onServiceDisconnected(name:ComponentName) { disconnected() }
    override fun onBindingDied(name:ComponentName) { disconnected() }
    override fun onNullBinding(name:ComponentName) { disconnected() }
    fun stop() { disconnected();context.stopService(Intent(context,RuntimeService::class.java)) }
}
