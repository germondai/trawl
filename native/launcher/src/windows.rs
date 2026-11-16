use std::{
    env,
    ffi::OsStr,
    fs::File,
    io,
    mem::{size_of, size_of_val},
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::Path,
    ptr,
    sync::atomic::{AtomicPtr, Ordering},
};
use windows_sys::Win32::{
    Foundation::*,
    Security::SECURITY_ATTRIBUTES,
    System::{Console::*, JobObjects::*, Pipes::*, Threading::*},
};

static CANCEL_PIPE: AtomicPtr<std::ffi::c_void> = AtomicPtr::new(ptr::null_mut());
unsafe fn close_cancel_pipe() {
    let pipe = CANCEL_PIPE.swap(ptr::null_mut(), Ordering::SeqCst);
    if !pipe.is_null() {
        CloseHandle(pipe);
    }
}
unsafe extern "system" fn console_event(event: u32) -> i32 {
    if matches!(event, CTRL_C_EVENT | CTRL_BREAK_EVENT) {
        close_cancel_pipe();
        return 1;
    }
    0
}
struct ConsoleGuard;
impl Drop for ConsoleGuard {
    fn drop(&mut self) {
        unsafe {
            SetConsoleCtrlHandler(Some(console_event), 0);
            close_cancel_pipe();
        }
    }
}

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}
fn quote(value: &OsStr) -> Vec<u16> {
    let mut output = vec![34];
    let mut slashes = 0;
    for ch in value.encode_wide() {
        if ch == 92 {
            slashes += 1;
            continue;
        }
        output.extend(std::iter::repeat_n(
            92,
            if ch == 34 { slashes * 2 + 1 } else { slashes },
        ));
        output.push(ch);
        slashes = 0;
    }
    output.extend(std::iter::repeat_n(92, slashes * 2));
    output.push(34);
    output
}
unsafe fn checked_handle(raw: HANDLE) -> io::Result<OwnedHandle> {
    if raw.is_null() || raw == INVALID_HANDLE_VALUE {
        Err(io::Error::last_os_error())
    } else {
        Ok(OwnedHandle::from_raw_handle(raw))
    }
}
unsafe fn standard_handle(kind: u32) -> io::Result<OwnedHandle> {
    let raw = GetStdHandle(kind);
    let fallback;
    let source = if raw.is_null() || raw == INVALID_HANDLE_VALUE {
        fallback = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open("NUL")?;
        fallback.as_raw_handle()
    } else {
        raw
    };
    duplicate(source)
}
unsafe fn duplicate(source: HANDLE) -> io::Result<OwnedHandle> {
    let mut copy = ptr::null_mut();
    if DuplicateHandle(
        GetCurrentProcess(),
        source,
        GetCurrentProcess(),
        &mut copy,
        0,
        1,
        DUPLICATE_SAME_ACCESS,
    ) == 0
    {
        return Err(io::Error::last_os_error());
    }
    checked_handle(copy)
}
struct Attributes {
    storage: Vec<usize>,
}
impl Attributes {
    unsafe fn new() -> io::Result<Self> {
        let mut bytes = 0;
        InitializeProcThreadAttributeList(ptr::null_mut(), 2, 0, &mut bytes);
        let mut this = Self {
            storage: vec![0; bytes.div_ceil(size_of::<usize>())],
        };
        if InitializeProcThreadAttributeList(this.pointer(), 2, 0, &mut bytes) == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(this)
    }
    fn pointer(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.storage.as_mut_ptr().cast()
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe { DeleteProcThreadAttributeList(self.pointer()) }
    }
}

// Attach the engine to its job at creation; no child can escape between spawn and assignment.
pub fn run(engine: &Path, script: &Path, log: Option<&File>) -> io::Result<i32> {
    unsafe {
        if log.is_some() {
            FreeConsole();
        }
        let job = checked_handle(CreateJobObjectW(ptr::null(), ptr::null()))?;
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            &limits as *const _ as _,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        let args: Vec<_> = env::args_os().skip(1).collect();
        let watching = args.iter().any(|arg| arg == "--watch-parent");
        let private = args
            .iter()
            .any(|arg| arg == "--manage" || arg == "--internal-pow-worker");
        let has_console = GetConsoleCP() != 0;
        let mut console_guard = None;
        let stdin = if has_console && !watching && !private {
            let security = SECURITY_ATTRIBUTES {
                nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: ptr::null_mut(),
                bInheritHandle: 1,
            };
            let mut read = ptr::null_mut();
            let mut write = ptr::null_mut();
            if CreatePipe(&mut read, &mut write, &security, 0) == 0 {
                return Err(io::Error::last_os_error());
            }
            let read = checked_handle(read)?;
            let write = checked_handle(write)?;
            if SetHandleInformation(write.as_raw_handle(), HANDLE_FLAG_INHERIT, 0) == 0 {
                return Err(io::Error::last_os_error());
            }
            use std::os::windows::io::IntoRawHandle;
            CANCEL_PIPE.store(write.into_raw_handle(), Ordering::SeqCst);
            env::set_var("TRAWL_PARENT_WATCH", "1");
            read
        } else {
            standard_handle(STD_INPUT_HANDLE)?
        };
        if has_console && (!private || watching) {
            console_guard = Some(ConsoleGuard);
            if SetConsoleCtrlHandler(Some(console_event), 1) == 0 {
                return Err(io::Error::last_os_error());
            }
        }
        let stdout = if let Some(log) = log {
            duplicate(log.as_raw_handle())?
        } else {
            standard_handle(STD_OUTPUT_HANDLE)?
        };
        let stderr = if let Some(log) = log {
            duplicate(log.as_raw_handle())?
        } else {
            standard_handle(STD_ERROR_HANDLE)?
        };
        let handles = [
            stdin.as_raw_handle(),
            stdout.as_raw_handle(),
            stderr.as_raw_handle(),
        ];
        let jobs = [job.as_raw_handle()];
        let mut attrs = Attributes::new()?;
        for (kind, data, bytes) in [
            (
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                handles.as_ptr() as _,
                size_of_val(&handles),
            ),
            (
                PROC_THREAD_ATTRIBUTE_JOB_LIST,
                jobs.as_ptr() as _,
                size_of_val(&jobs),
            ),
        ] {
            if UpdateProcThreadAttribute(
                attrs.pointer(),
                0,
                kind as usize,
                data,
                bytes,
                ptr::null_mut(),
                ptr::null(),
            ) == 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        let mut startup = STARTUPINFOEXW::default();
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = stdin.as_raw_handle();
        startup.StartupInfo.hStdOutput = stdout.as_raw_handle();
        startup.StartupInfo.hStdError = stderr.as_raw_handle();
        startup.lpAttributeList = attrs.pointer();
        let args = std::iter::once(engine.as_os_str().to_owned())
            .chain(["--no-env-file".into(), script.as_os_str().to_owned()])
            .chain(args);
        let mut command = Vec::new();
        for arg in args {
            if !command.is_empty() {
                command.push(32)
            }
            command.extend(quote(&arg));
        }
        command.push(0);
        let mut process = PROCESS_INFORMATION::default();
        if CreateProcessW(
            wide(engine.as_os_str()).as_ptr(),
            command.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            1,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW,
            ptr::null(),
            ptr::null(),
            &startup.StartupInfo,
            &mut process,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        let process_handle = checked_handle(process.hProcess)?;
        let _thread = checked_handle(process.hThread)?;
        if WaitForSingleObject(process_handle.as_raw_handle(), INFINITE) == WAIT_FAILED {
            return Err(io::Error::last_os_error());
        }
        let mut code = 1;
        if GetExitCodeProcess(process_handle.as_raw_handle(), &mut code) == 0 {
            return Err(io::Error::last_os_error());
        }
        drop(console_guard);
        Ok(code as i32)
    }
}
