use crate::AppState;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{mpsc, Arc, OnceLock},
    time::{Duration, Instant},
};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::State;

struct Sampler {
    system: System,
    last: Option<(Instant, Value)>,
    disk: Option<(Instant, Value)>,
}
struct SampleJob {
    home: PathBuf,
    runtime: PathBuf,
    server: Option<u32>,
    fresh: bool,
    reply: tokio::sync::oneshot::Sender<Result<Value, String>>,
}
// Keep sampling off the UI thread and preserve consecutive CPU samples.
static SAMPLER: OnceLock<Result<mpsc::SyncSender<SampleJob>, String>> = OnceLock::new();

// Logical file sizes; never follow symlinks or let a large installation block the UI.
fn directory_size(path: &Path) -> (u64, bool) {
    let deadline = Instant::now() + Duration::from_millis(150);
    let mut pending = vec![path.to_path_buf()];
    let mut bytes = 0u64;
    let mut count = 0;
    let mut partial = false;
    while let Some(path) = pending.pop() {
        if count >= 20000 || Instant::now() >= deadline {
            return (bytes, true);
        }
        count += 1;
        match std::fs::symlink_metadata(&path) {
            Ok(info) if info.file_type().is_symlink() => {}
            Ok(info) if info.is_file() => bytes = bytes.saturating_add(info.len()),
            Ok(info) if info.is_dir() => match std::fs::read_dir(&path) {
                Ok(entries) => {
                    for entry in entries.take(20001) {
                        match entry {
                            Ok(entry) => pending.push(entry.path()),
                            Err(_) => partial = true,
                        }
                        if pending.len() > 20000 {
                            return (bytes, true);
                        }
                    }
                }
                Err(_) => partial = true,
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            _ => partial = true,
        }
    }
    (bytes, partial)
}
fn sample(
    guard: &mut Option<Sampler>,
    home: PathBuf,
    runtime: PathBuf,
    server: Option<u32>,
) -> Result<Value, String> {
    if guard.is_none() {
        *guard = Some(Sampler {
            system: System::new().map_err(|_| "System metrics are unavailable")?,
            last: None,
            disk: None,
        });
    }
    let sampler = guard.as_mut().unwrap();
    if let Some((at, value)) = &sampler.last {
        if at.elapsed() < Duration::from_secs(2) {
            return Ok(value.clone());
        }
    }
    let has_cpu = sampler.last.is_some();
    sampler.system.refresh_memory();
    sampler.system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_cpu()
            .with_memory()
            .without_tasks(),
    );
    let mut owned = HashSet::from([Pid::from_u32(std::process::id())]);
    if let Some(pid) = server {
        owned.insert(Pid::from_u32(pid));
    }
    loop {
        let before = owned.len();
        for (pid, process) in sampler.system.processes() {
            if owned.len() >= 200 {
                break;
            }
            if process.parent().is_some_and(|pid| owned.contains(&pid)) {
                owned.insert(*pid);
            }
        }
        if owned.len() == before || owned.len() >= 200 {
            break;
        }
    }
    let mut processes = Vec::new();
    let mut memory = 0u64;
    let mut cpu = 0.0f32;
    for pid in owned {
        if let Some(process) = sampler.system.process(pid) {
            memory = memory.saturating_add(process.memory());
            cpu += process.cpu_usage();
            processes.push(json!({"pid":pid.as_u32(), "name":process.name().to_string_lossy(), "memoryBytes":process.memory(), "cpuPercent":has_cpu.then_some(process.cpu_usage())}));
        }
    }
    processes.sort_by_key(|p| std::cmp::Reverse(p["memoryBytes"].as_u64().unwrap_or(0)));
    if sampler
        .disk
        .as_ref()
        .is_none_or(|(at, _)| at.elapsed() > Duration::from_secs(60))
    {
        let entries = [
            (
                "Desktop executable",
                std::env::current_exe().map_err(|_| "Application path unavailable")?,
            ),
            ("Browser", home.join("browser")),
            ("Stored browsers", home.join("browsers")),
            ("Bundled runtime", runtime),
            ("Downloads", home.join("downloads")),
            ("Logs", home.join("logs")),
            ("Request and response captures", home.join("captures")),
            ("Metrics", home.join("metrics.sqlite")),
            ("Metrics journal", home.join("metrics.sqlite-wal")),
        ];
        let entries: Vec<Value> = entries
            .into_iter()
            .map(|(name, path)| {
                let (bytes, partial) = directory_size(&path);
                json!({"name":name,"bytes":bytes,"partial":partial})
            })
            .collect();
        sampler.disk = Some((Instant::now(), json!({"entries":entries})));
    }
    let value = json!({"processes":processes,"memoryBytes":memory,"cpuPercent":has_cpu.then_some(cpu),"logicalCpus":std::thread::available_parallelism().map(|n|n.get()).unwrap_or(1),"hostMemory":{"totalBytes":sampler.system.total_memory(),"availableBytes":sampler.system.available_memory()},"disk":sampler.disk.as_ref().map(|(_,value)|value),"sampledAt":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()});
    sampler.last = Some((Instant::now(), value.clone()));
    Ok(value)
}
#[tauri::command]
pub async fn resource_usage(
    state: State<'_, Arc<AppState>>,
    fresh: Option<bool>,
) -> Result<Value, String> {
    let home = state.home.clone();
    let runtime = state.runtime.clone();
    let server = crate::runtime::local_server_pid(&state).await;
    let sender = SAMPLER
        .get_or_init(|| {
            let (sender, receiver) = mpsc::sync_channel::<SampleJob>(1);
            std::thread::Builder::new()
                .name("trawl-resources".into())
                .spawn(move || {
                    let mut sampler: Option<Sampler> = None;
                    while let Ok(job) = receiver.recv() {
                        if job.fresh {
                            if let Some(sampler) = &mut sampler {
                                sampler.disk = None;
                                sampler.last = None;
                            }
                        }
                        let value = sample(&mut sampler, job.home, job.runtime, job.server);
                        let _ = job.reply.send(value);
                    }
                })
                .map_err(|_| "Resource sampler could not start".to_string())?;
            Ok(sender)
        })
        .as_ref()
        .map_err(Clone::clone)?;
    let (reply, receive) = tokio::sync::oneshot::channel();
    sender
        .try_send(SampleJob {
            home,
            runtime,
            server,
            fresh: fresh.unwrap_or(false),
            reply,
        })
        .map_err(|_| "Resource sampler is busy")?;
    receive.await.map_err(|_| "Resource sampler failed")?
}

fn storage_path(name: &str, state: &AppState) -> Result<PathBuf, String> {
    Ok(match name {
        "Desktop executable" => {
            std::env::current_exe().map_err(|_| "Application path unavailable")?
        }
        "Bundled runtime" => state.runtime.clone(),
        "Browser" => state.home.join("browser"),
        "Downloads" => state.home.join("downloads"),
        "Logs" => state.home.join("logs"),
        "Request and response captures" => state.home.join("captures"),
        "Metrics" => state.home.join("metrics.sqlite"),
        "Metrics journal" => state.home.join("metrics.sqlite-wal"),
        _ => return Err("Unknown managed storage location".into()),
    })
}

#[tauri::command]
pub async fn reveal_storage(state: State<'_, Arc<AppState>>, name: String) -> Result<(), String> {
    let mut path = storage_path(&name, &state)?;
    while !path.exists() {
        path = path
            .parent()
            .ok_or("Storage location is unavailable")?
            .to_path_buf();
    }
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut c = tokio::process::Command::new("/usr/bin/open");
        c.arg("-R").arg(&path);
        c
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut c = tokio::process::Command::new("explorer.exe");
        c.arg("/select,").arg(&path);
        c
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut command = {
        let mut c = tokio::process::Command::new("xdg-open");
        c.arg(if path.is_dir() {
            &path
        } else {
            path.parent().ok_or("Storage location is unavailable")?
        });
        c
    };
    command
        .status()
        .await
        .map_err(|_| "Could not open the file manager")?
        .success()
        .then_some(())
        .ok_or("Could not open the file manager".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn directory_accounting_does_not_follow_links() {
        let root = std::env::temp_dir().join(format!("trawl-resources-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("data"), [0u8; 13]).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&root, root.join("cycle")).unwrap();
        assert_eq!(directory_size(&root), (13, false));
        std::fs::remove_dir_all(root).unwrap();
    }
}
