//! Drain both process pipes while the child is alive. Never wait for EOF from
//! descendants which may have inherited a pipe after their parent exited.
use std::{
    io::Read,
    process::{Command, Output, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

#[cfg(windows)]
mod windows {
    use std::{
        io::{self, Read},
        os::windows::{
            io::{AsRawHandle, FromRawHandle, OwnedHandle},
            process::CommandExt,
        },
        process::{Child, Command},
        ptr::{null, null_mut},
    };
    use windows_sys::Win32::{
        Foundation::{ERROR_BROKEN_PIPE, ERROR_NO_MORE_FILES, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First,
                Thread32Next,
            },
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
                SetInformationJobObject,
            },
            Pipes::PeekNamedPipe,
            Threading::{
                CREATE_NO_WINDOW, CREATE_SUSPENDED, OpenThread, ResumeThread, THREAD_SUSPEND_RESUME,
            },
        },
    };

    // Keep the job handle alive until the worker has finished; closing it
    // stops owned descendants that would otherwise hold open inherited pipes.
    pub(crate) fn spawn(command: &mut Command) -> io::Result<(Child, OwnedHandle)> {
        // SAFETY: both null arguments select unnamed/default security, and the
        // returned handle is checked before transferring its ownership to Rust.
        let handle = unsafe { CreateJobObjectW(null(), null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = unsafe { OwnedHandle::from_raw_handle(handle) };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: both handles are valid while borrowed. Windows reads exactly
        // the size supplied for the initialized extended limits structure.
        if unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        // The worker must not run until it is in the job: a one-file Python
        // executable can launch a child during its bootloader initialization.
        let mut child = command
            .creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED)
            .spawn()?;
        let start = (|| {
            // SAFETY: this borrows the valid, still-suspended process handle.
            if unsafe { AssignProcessToJobObject(handle, child.as_raw_handle()) } == 0 {
                return Err(io::Error::last_os_error());
            }
            resume_initial_thread(&child)
        })();
        if let Err(error) = start {
            drop(job);
            super::super::terminate_child_process_tree(&mut child);
            return Err(error);
        }
        Ok((child, job))
    }

    fn resume_initial_thread(child: &Child) -> io::Result<()> {
        // SAFETY: this asks Windows for a read-only thread listing, and every
        // owning handle created below is checked against its failure sentinel.
        let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if raw == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let snapshot = unsafe { OwnedHandle::from_raw_handle(raw) };
        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        let mut available = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) };
        while available != 0 {
            if entry.th32OwnerProcessID == child.id() {
                // The only thread in this newly suspended process is its
                // primary thread. A live Child still owns the process ID.
                let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
                if thread.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let thread = unsafe { OwnedHandle::from_raw_handle(thread) };
                if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
                    return Err(io::Error::last_os_error());
                }
                return Ok(());
            }
            entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
            available = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) };
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(ERROR_NO_MORE_FILES as i32) {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "找不到执行器的初始线程",
            ));
        }
        Err(error)
    }

    pub(super) struct NonblockingPipe<T>(pub T);

    impl<T: Read + AsRawHandle> Read for NonblockingPipe<T> {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            let mut available = 0;
            // SAFETY: this pipe is owned by the wrapper. The only output
            // buffer is an initialized DWORD for the unread byte count.
            if unsafe {
                PeekNamedPipe(
                    self.0.as_raw_handle(),
                    null_mut(),
                    0,
                    null_mut(),
                    &mut available,
                    null_mut(),
                )
            } == 0
            {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) {
                    return Ok(0);
                }
                return Err(error);
            }
            if available == 0 {
                return Err(io::ErrorKind::WouldBlock.into());
            }
            let len = buffer.len().min(available as usize);
            self.0.read(&mut buffer[..len])
        }
    }
}

#[cfg(windows)]
pub(crate) use windows::spawn as spawn_windows_worker;

const OUTPUT_TAIL: usize = 256 * 1024;
const MAX_EVENT: usize = 2 * 1024 * 1024;

fn append_tail(target: &mut Vec<u8>, bytes: &[u8]) {
    target.extend_from_slice(bytes);
    if target.len() > OUTPUT_TAIL {
        target.drain(..target.len() - OUTPUT_TAIL);
    }
}

#[cfg(unix)]
fn nonblocking(pipe: &impl std::os::fd::AsRawFd) -> Result<(), String> {
    let fd = pipe.as_raw_fd();
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        if flags == -1 || libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) == -1 {
            return Err(format!(
                "无法读取执行进度：{}",
                std::io::Error::last_os_error()
            ));
        }
    }
    Ok(())
}

pub(crate) fn run(
    command: &mut Command,
    cancellation: &AtomicBool,
    timeout: Duration,
    on_event: impl FnMut(serde_json::Value),
) -> Result<Output, String> {
    run_with_cleanup(command, cancellation, timeout, false, on_event)
}

pub(crate) fn run_probe(command: &mut Command, timeout: Duration) -> Result<Output, String> {
    run_with_cleanup(command, &AtomicBool::new(false), timeout, true, |_| {})
}

fn run_with_cleanup(
    command: &mut Command,
    cancellation: &AtomicBool,
    timeout: Duration,
    cleanup_on_success: bool,
    mut on_event: impl FnMut(serde_json::Value),
) -> Result<Output, String> {
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (command, cancellation, timeout, cleanup_on_success, on_event);
        return Err("此平台尚未实现流式进程执行器".into());
    }
    #[cfg(any(unix, windows))]
    {
        #[cfg(windows)]
        {
            let _ = cleanup_on_success; // Windows always closes the job on exit.
        }
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(unix)]
        super::isolate_child_process_group(command);
        #[cfg(unix)]
        let mut child = command
            .spawn()
            .map_err(|e| format!("无法启动执行器：{e}"))?;
        #[cfg(windows)]
        let (mut child, job) =
            windows::spawn(command).map_err(|error| format!("无法启动受控执行器：{error}"))?;
        #[cfg(windows)]
        let mut job = Some(job);
        let result = (|| {
            let stdout = child.stdout.take().ok_or("执行器缺少 stdout")?;
            let stderr = child.stderr.take().ok_or("执行器缺少 stderr")?;
            #[cfg(unix)]
            let (mut stdout, mut stderr) = {
                nonblocking(&stdout)?;
                nonblocking(&stderr)?;
                (stdout, stderr)
            };
            #[cfg(windows)]
            let (mut stdout, mut stderr) = (
                windows::NonblockingPipe(stdout),
                windows::NonblockingPipe(stderr),
            );
            let start = Instant::now();
            let mut out = Vec::new();
            let mut err = Vec::new();
            let mut pending = Vec::new();
            let mut oversized = false;
            loop {
                if cancellation.load(Ordering::SeqCst) {
                    return Err("__ZHAI_CODEX_CANCELLED__".into());
                }
                if start.elapsed() >= timeout {
                    return Err("执行超时，已停止本轮任务".into());
                }
                // Bound work per iteration so a noisy child cannot starve
                // cancellation, stderr or process-status checks.
                for (pipe, tail, is_stdout) in [
                    (&mut stdout as &mut dyn Read, &mut out, true),
                    (&mut stderr as &mut dyn Read, &mut err, false),
                ] {
                    let mut buffer = [0u8; 16 * 1024];
                    for _ in 0..32 {
                        match pipe.read(&mut buffer) {
                            Ok(0) => break,
                            Ok(size) => {
                                append_tail(tail, &buffer[..size]);
                                if is_stdout {
                                    for &byte in &buffer[..size] {
                                        if byte == b'\n' {
                                            if !oversized {
                                                if let Ok(value) = serde_json::from_slice(&pending)
                                                {
                                                    on_event(value);
                                                }
                                            }
                                            pending.clear();
                                            oversized = false;
                                        } else if !oversized {
                                            pending.push(byte);
                                            if pending.len() > MAX_EVENT {
                                                pending.clear();
                                                oversized = true;
                                            }
                                        }
                                    }
                                }
                            }
                            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                            Err(e) => return Err(format!("无法读取执行器输出：{e}")),
                        }
                    }
                }
                // Probe cleanup must happen before reaping its leader: an
                // unreaped PID still proves ownership of the original group,
                // including children reparented when the probe exited.
                #[cfg(unix)]
                if cleanup_on_success {
                    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
                    let result = unsafe {
                        libc::waitid(
                            libc::P_PID,
                            child.id(),
                            &mut info,
                            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                        )
                    };
                    if result == -1 {
                        let error = std::io::Error::last_os_error();
                        if error.kind() != std::io::ErrorKind::Interrupted {
                            return Err(format!("无法检查组件退出状态：{error}"));
                        }
                        continue;
                    } else if unsafe { info.si_pid() } == child.id() as i32 {
                        super::terminate_child_process_tree(&mut child);
                    } else {
                        std::thread::sleep(Duration::from_millis(30));
                        continue;
                    }
                }
                if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                    #[cfg(windows)]
                    drop(job.take());
                    // Pipes were drained above. One final bounded drain captures
                    // bytes written between the read and the exit observation.
                    let mut buffer = [0u8; 16 * 1024];
                    for (pipe, tail, is_stdout) in [
                        (&mut stdout as &mut dyn Read, &mut out, true),
                        (&mut stderr as &mut dyn Read, &mut err, false),
                    ] {
                        for _ in 0..32 {
                            match pipe.read(&mut buffer) {
                                Ok(0) => break,
                                Ok(n) => {
                                    append_tail(tail, &buffer[..n]);
                                    if is_stdout {
                                        pending.extend_from_slice(&buffer[..n]);
                                        while let Some(end) =
                                            pending.iter().position(|b| *b == b'\n')
                                        {
                                            if !oversized && end <= MAX_EVENT {
                                                if let Ok(v) =
                                                    serde_json::from_slice(&pending[..end])
                                                {
                                                    on_event(v);
                                                }
                                            }
                                            pending.drain(..=end);
                                            oversized = false;
                                        }
                                        if pending.len() > MAX_EVENT {
                                            pending.clear();
                                            oversized = true;
                                        }
                                    }
                                }
                                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                                Err(_) => break,
                            }
                        }
                    }
                    if !oversized && !pending.is_empty() {
                        if let Ok(v) = serde_json::from_slice(&pending) {
                            on_event(v);
                        }
                    }
                    return Ok(Output {
                        status,
                        stdout: out,
                        stderr: err,
                    });
                }
                std::thread::sleep(Duration::from_millis(30));
            }
        })();
        #[cfg(windows)]
        drop(job.take());
        if result.is_err() {
            super::terminate_child_process_tree(&mut child);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_python() -> Command {
        Command::new(std::env::var_os("ZHAI_TEST_PYTHON3").unwrap_or_else(|| {
            if cfg!(windows) {
                "python3"
            } else {
                "/usr/bin/python3"
            }
            .into()
        }))
    }

    #[test]
    fn large_stdout_and_stderr_do_not_deadlock_and_events_arrive_before_exit() {
        let mut command = test_python();
        command.args(["-c", "import sys,time\nprint('{\"type\":\"started\"}', flush=True)\ntime.sleep(.2)\nsys.stderr.write('e'*2000000)\nsys.stderr.flush()\nsys.stdout.write('x'*3000000+'\\n')\nprint('{\"type\":\"done\"}', flush=True)"]);
        let started = Instant::now();
        let mut events = Vec::new();
        let output = run(
            &mut command,
            &AtomicBool::new(false),
            Duration::from_secs(10),
            |v| events.push((v, started.elapsed())),
        )
        .unwrap();
        assert!(output.status.success());
        assert_eq!(events[0].0["type"], "started");
        assert_eq!(events.last().unwrap().0["type"], "done");
        assert!(events[0].1 < events.last().unwrap().1);
        assert!(output.stderr.len() <= OUTPUT_TAIL);
        assert!(output.stdout.len() <= OUTPUT_TAIL);
    }

    #[test]
    fn cancellation_interrupts_a_running_process() {
        let flag = AtomicBool::new(false);
        let mut command = test_python();
        command.args([
            "-c",
            "import time\nprint('{\"ready\":true}',flush=True)\ntime.sleep(20)",
        ]);
        let start = Instant::now();
        let error = run(&mut command, &flag, Duration::from_secs(5), |_| {
            flag.store(true, Ordering::SeqCst)
        })
        .unwrap_err();
        assert_eq!(error, "__ZHAI_CODEX_CANCELLED__");
        assert!(start.elapsed() < Duration::from_secs(5));
    }

    #[cfg(windows)]
    #[test]
    fn cancellation_also_stops_a_child_started_by_the_worker() {
        let marker = std::env::temp_dir().join(format!("zhai-worker-{}.txt", uuid::Uuid::new_v4()));
        let program = concat!(
            "import subprocess, sys, time\n",
            "child = 'import pathlib, sys, time; time.sleep(1); pathlib.Path(sys.argv[1]).touch()'\n",
            "subprocess.Popen([sys.executable, '-c', child, sys.argv[1]])\n",
            "print('{\"ready\":true}', flush=True)\n",
            "time.sleep(20)\n",
        );
        let mut command = test_python();
        command.args(["-c", program]).arg(&marker);
        let cancel = AtomicBool::new(false);
        let result = run(&mut command, &cancel, Duration::from_secs(8), |event| {
            if event["ready"] == true {
                cancel.store(true, Ordering::SeqCst);
            }
        });
        assert_eq!(result.unwrap_err(), "__ZHAI_CODEX_CANCELLED__");
        std::thread::sleep(Duration::from_millis(1250));
        assert!(!marker.exists());
    }
}
