//! Service calls must outlive the Activity. Tauri's mobile plugin dispatcher
//! requires a live Wry Activity, so background work uses the retained JVM object.
use jni::{
    objects::{JObject, JString, JValue},
    refs::Global,
    EnvUnowned, JavaVM,
};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicI32, Ordering},
        Arc, Mutex, OnceLock,
    },
};
use tokio::sync::oneshot;

struct Bridge {
    vm: JavaVM,
    plugin: Mutex<Option<Arc<Global<JObject<'static>>>>>,
}
type Reply = Result<Value, String>;
static BRIDGE: OnceLock<Bridge> = OnceLock::new();
static SERVICE: OnceLock<Bridge> = OnceLock::new();
static NEXT: AtomicI32 = AtomicI32::new(1);
static PENDING: OnceLock<Mutex<HashMap<i32, oneshot::Sender<Reply>>>> = OnceLock::new();
fn pending() -> &'static Mutex<HashMap<i32, oneshot::Sender<Reply>>> {
    PENDING.get_or_init(Default::default)
}
struct Pending(i32);
impl Drop for Pending {
    fn drop(&mut self) {
        pending().lock().unwrap().remove(&self.0);
    }
}

fn dispatch(method: &str, args: &Value, id: i32) -> Result<(), String> {
    let background = matches!(
        method,
        "setState"
            | "serverIntent"
            | "browser"
            | "cancelBrowser"
            | "ensureService"
            | "actionFeedback"
            | "runtimeFailure"
            | "runtimeReply"
            | "resources"
            | "notifyTask"
    );
    let service = SERVICE.get().and_then(|bridge| {
        bridge
            .plugin
            .lock()
            .unwrap()
            .clone()
            .map(|plugin| (bridge, plugin))
    });
    let (bridge, plugin) = if background && service.is_some() {
        service.unwrap()
    } else {
        let bridge = BRIDGE.get().ok_or("Android service bridge is not ready")?;
        let plugin = bridge
            .plugin
            .lock()
            .unwrap()
            .clone()
            .ok_or("Android service bridge is not ready")?;
        (bridge, plugin)
    };
    bridge
        .vm
        .attach_current_thread(|env| -> jni::errors::Result<()> {
            let method = env.new_string(method)?;
            let data = env.new_string(args.to_string())?;
            env.call_method(
                plugin.as_ref(),
                jni::jni_str!("dispatch"),
                jni::jni_sig!("(ILjava/lang/String;Ljava/lang/String;)V"),
                &[JValue::Int(id), (&method).into(), (&data).into()],
            )?;
            Ok(())
        })
        .map_err(|e| format!("Android service call failed: {e}"))?;
    Ok(())
}

pub async fn call(method: &str, args: Value) -> Reply {
    let timeout = if method == "browser" {
        args["maxTimeout"].as_u64().unwrap_or(60000).min(180000) + 10000
    } else {
        10000
    };
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel();
    pending().lock().unwrap().insert(id, tx);
    let _pending = Pending(id);
    dispatch(method, &args, id)?;
    tokio::time::timeout(std::time::Duration::from_millis(timeout), rx)
        .await
        .map_err(|_| "Android service reply timed out".to_string())?
        .map_err(|_| "Android service reply was closed".to_string())?
}

#[no_mangle]
#[allow(non_snake_case)]
pub extern "system" fn Java_com_germondai_trawl_mobile_RuntimePlugin_nativeReady(
    mut env: EnvUnowned,
    plugin: JObject,
) {
    env.with_env(|env| -> jni::errors::Result<()> {
        if let (Ok(vm), Ok(plugin)) = (env.get_java_vm(), env.new_global_ref(plugin)) {
            let bridge = BRIDGE.get_or_init(|| Bridge {
                vm,
                plugin: Mutex::new(None),
            });
            *bridge.plugin.lock().unwrap() = Some(Arc::new(plugin));
        }

        Ok(())
    })
    .resolve::<jni::errors::LogErrorAndDefault>();
}

#[no_mangle]
#[allow(non_snake_case)]
pub extern "system" fn Java_com_germondai_trawl_mobile_RuntimePlugin_nativeReply(
    mut env: EnvUnowned,
    _: JObject,
    id: i32,
    success: jni::sys::jboolean,
    data: JString,
) {
    env.with_env(|env| -> jni::errors::Result<()> {
        let reply = data
            .try_to_string(env)
            .map_err(|e| e.to_string())
            .and_then(|s| serde_json::from_str::<Value>(&s).map_err(|e| e.to_string()))
            .and_then(|value| {
                if success {
                    Ok(value)
                } else {
                    Err(value["message"]
                        .as_str()
                        .unwrap_or("Android service call failed")
                        .to_owned())
                }
            });
        if let Some(tx) = pending().lock().unwrap().remove(&id) {
            let _ = tx.send(reply);
        }

        Ok(())
    })
    .resolve::<jni::errors::LogErrorAndDefault>();
}

#[no_mangle]
#[allow(non_snake_case)]
pub extern "system" fn Java_com_germondai_trawl_mobile_RuntimeService_nativeReady(
    mut env: EnvUnowned,
    service: JObject,
) {
    env.with_env(|env| -> jni::errors::Result<()> {
        if let (Ok(vm), Ok(service)) = (env.get_java_vm(), env.new_global_ref(service)) {
            let bridge = SERVICE.get_or_init(|| Bridge {
                vm,
                plugin: Mutex::new(None),
            });
            *bridge.plugin.lock().unwrap() = Some(Arc::new(service));
        }

        Ok(())
    })
    .resolve::<jni::errors::LogErrorAndDefault>();
}
#[no_mangle]
#[allow(non_snake_case)]
pub extern "system" fn Java_com_germondai_trawl_mobile_RuntimeService_nativeRelease(
    _: EnvUnowned,
    _: JObject,
) {
    if let Some(bridge) = SERVICE.get() {
        *bridge.plugin.lock().unwrap() = None;
    }
}
#[no_mangle]
#[allow(non_snake_case)]
pub extern "system" fn Java_com_germondai_trawl_mobile_RuntimeService_nativeReply(
    env: EnvUnowned,
    service: JObject,
    id: i32,
    success: jni::sys::jboolean,
    data: JString,
) {
    Java_com_germondai_trawl_mobile_RuntimePlugin_nativeReply(env, service, id, success, data)
}
