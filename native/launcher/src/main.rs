#[cfg(windows)]
mod windows;
use std::{
    env,
    fs::{File, OpenOptions},
    process::{Command, ExitCode},
};
fn service_log() -> Result<Option<File>, Box<dyn std::error::Error>> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    if !args.iter().any(|arg| arg == "--service") {
        return Ok(None);
    }
    let home = args
        .windows(2)
        .find(|pair| pair[0] == "--home")
        .map(|pair| std::path::PathBuf::from(&pair[1]))
        .ok_or("Service requires --home")?;
    let path = home.join("logs/server.log");
    if std::fs::symlink_metadata(&path)
        .is_ok_and(|meta| meta.file_type().is_symlink() || !meta.is_file())
    {
        return Err("Service log must be a regular file".into());
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    Ok(Some(options.open(path)?))
}
fn run() -> Result<i32, Box<dyn std::error::Error>> {
    let executable = env::current_exe()?;
    let root = executable
        .parent()
        .ok_or("Runtime directory is unavailable")?;
    let bun = root.join(if cfg!(windows) {
        "trawl-engine.exe"
    } else {
        "trawl-engine"
    });
    let mut command = Command::new(bun);
    command.arg("--no-env-file").arg(root.join("runtime.mjs"));
    command.args(env::args_os().skip(1));
    command.env("TRAWL_RUNTIME_RESOURCES", root);
    let log = service_log()?;
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        if let Some(log) = log {
            command.stdout(log.try_clone()?).stderr(log);
        }
        let error = command.arg0("trawl-server").exec();
        return Err(error.into());
    }
    #[cfg(windows)]
    {
        std::env::set_var("TRAWL_RUNTIME_RESOURCES", root);
        Ok(windows::run(
            &root.join("trawl-engine.exe"),
            &root.join("runtime.mjs"),
            log.as_ref(),
        )?)
    }
}
fn main() -> ExitCode {
    match run() {
        Ok(code) => ExitCode::from(code.clamp(0, 255) as u8),
        Err(error) => {
            eprintln!("TRAWL runtime could not start: {error}");
            ExitCode::FAILURE
        }
    }
}
