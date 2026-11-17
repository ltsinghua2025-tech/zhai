//! Bounded cancellation of an owned child and its descendants, including
//! descendants which created a different process group or session.
//!
//! This is cancellation, not a containment boundary: a daemon which was already
//! reparented before cancellation cannot be attributed from a process snapshot.
//! Callers must retain the root unreaped (WNOWAIT when observing normal exit).
use std::{
    process::Child,
    time::{Duration, Instant},
};

#[derive(Debug, Default)]
pub(crate) struct TerminationReport {
    pub root_reaped: bool,
    pub signalled: usize,
    pub warnings: Vec<String>,
}

pub(crate) fn terminate(child: &mut Child) -> TerminationReport {
    #[cfg(unix)]
    let report = unix::terminate_with_ps(child, "/bin/ps");
    #[cfg(not(unix))]
    let report = {
        let _ = child.kill();
        let mut report = TerminationReport::default();
        reap(child, &mut report);
        report
    };
    for warning in &report.warnings {
        eprintln!("进程回收：{warning}");
    }
    report
}

fn reap(child: &mut Child, report: &mut TerminationReport) {
    let deadline = Instant::now() + Duration::from_millis(400);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                report.root_reaped = true;
                return;
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
            Ok(None) => {
                report
                    .warnings
                    .push("根进程尚未退出，已发送终止信号；未无限等待".into());
                return;
            }
            Err(error) => {
                report.warnings.push(format!("无法回收根进程：{error}"));
                return;
            }
        }
    }
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::{
        collections::HashMap,
        io::Read,
        os::fd::AsRawFd,
        os::unix::process::CommandExt,
        process::{Command, Stdio},
    };

    #[derive(Clone, Copy, Debug)]
    pub(super) struct Identity {
        pub pid: i32,
        pub parent: i32,
        group: i32,
        birth: (u64, u64),
        pub zombie: bool,
    }

    #[cfg(target_os = "linux")]
    pub(super) fn identity(pid: i32) -> Option<Identity> {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // comm can contain spaces and closing parentheses. Fields after its
        // final ')' start at field 3 (state); starttime is field 22.
        let fields: Vec<_> = stat.rsplit_once(')')?.1.split_whitespace().collect();
        Some(Identity {
            pid,
            parent: fields.get(1)?.parse().ok()?,
            group: fields.get(2)?.parse().ok()?,
            birth: (fields.get(19)?.parse().ok()?, 0),
            zombie: *fields.first()? == "Z",
        })
    }

    #[cfg(target_os = "macos")]
    pub(super) fn identity(pid: i32) -> Option<Identity> {
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of_val(&info) as i32;
        let read = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                // XNU proc_info.c uses nonzero arg to include zombies for
                // PROC_PIDTBSDINFO. A zero arg hides an unreaped exited root.
                1,
                (&mut info as *mut libc::proc_bsdinfo).cast(),
                size,
            )
        };
        (read == size).then_some(Identity {
            pid,
            parent: info.pbi_ppid as i32,
            group: info.pbi_pgid as i32,
            birth: (info.pbi_start_tvsec, info.pbi_start_tvusec),
            zombie: info.pbi_status == 5,
        })
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    pub(super) fn identity(_pid: i32) -> Option<Identity> {
        None
    }

    fn still_same(expected: Identity) -> bool {
        identity(expected.pid).is_some_and(|now| now.birth == expected.birth)
    }

    fn signal(expected: Identity, signal: i32) -> bool {
        // Never signal our own process or a reused PID. The original root is
        // retained as an unreaped Child until all descendant signals are sent.
        expected.pid > 1
            && expected.pid != std::process::id() as i32
            && still_same(expected)
            && unsafe { libc::kill(expected.pid, signal) == 0 }
    }

    fn snapshot(program: &str) -> Result<Vec<(i32, i32)>, String> {
        let mut ps = Command::new(program)
            .args(["-axo", "pid=,ppid="])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .map_err(|error| format!("无法枚举子进程：{error}"))?;
        let result = (|| {
            let mut stdout = ps.stdout.take().ok_or("进程枚举缺少输出")?;
            let fd = stdout.as_raw_fd();
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
            if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
            {
                return Err("无法设置进程枚举限时读取".into());
            }
            let deadline = Instant::now() + Duration::from_millis(300);
            let mut data = Vec::new();
            let mut buffer = [0; 16 * 1024];
            loop {
                // Bound each drain, including when ps produces continuous data.
                for _ in 0..32 {
                    match stdout.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(count) => data.extend_from_slice(&buffer[..count]),
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(error) => return Err(format!("进程枚举读取失败：{error}")),
                    }
                }
                if data.len() > 4 * 1024 * 1024 {
                    return Err("进程枚举输出超过上限".into());
                }
                if let Some(status) = ps.try_wait().map_err(|error| error.to_string())? {
                    if !status.success() {
                        return Err("进程枚举失败".into());
                    }
                    // The child has exited; drain the final pipe bytes without
                    // waiting for EOF from any inherited descriptor.
                    loop {
                        match stdout.read(&mut buffer) {
                            Ok(0) | Err(_) => break,
                            Ok(count) => {
                                data.extend_from_slice(&buffer[..count]);
                                if data.len() > 4 * 1024 * 1024 {
                                    return Err("进程枚举输出超过上限".into());
                                }
                            }
                        }
                    }
                    return String::from_utf8_lossy(&data)
                        .lines()
                        .map(|line| {
                            let mut fields = line.split_whitespace();
                            let pid = fields
                                .next()
                                .and_then(|p| p.parse().ok())
                                .ok_or("无效进程 PID")?;
                            let parent = fields
                                .next()
                                .and_then(|p| p.parse().ok())
                                .ok_or("无效父进程 PID")?;
                            Ok((pid, parent))
                        })
                        .collect();
                }
                if Instant::now() >= deadline {
                    return Err("进程枚举超过 300 毫秒".into());
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        })();
        if result.is_err() {
            let _ = ps.kill();
            let mut report = TerminationReport::default();
            reap(&mut ps, &mut report);
        }
        result
    }

    pub(super) fn terminate_with_ps(child: &mut Child, ps: &str) -> TerminationReport {
        let mut report = TerminationReport::default();
        let root_pid = child.id() as i32;
        // An owned Child normally remains unreaped here. A reused PID belonging
        // to another parent is not an authorized root.
        let root = identity(root_pid).filter(|p| p.parent == std::process::id() as i32);
        let mut known: HashMap<i32, (Identity, usize)> = HashMap::new();
        if let Some(root) = root {
            if !signal(root, libc::SIGSTOP) && !root.zombie && still_same(root) {
                report
                    .warnings
                    .push("根进程暂停失败，子进程快照可能继续变化".into());
            }
            known.insert(root.pid, (root, 0));
            let deadline = Instant::now() + Duration::from_millis(1200);
            let mut stable = 0;
            while stable < 2 && Instant::now() < deadline {
                let rows = match snapshot(ps) {
                    Ok(rows) => rows,
                    Err(error) => {
                        report.warnings.push(error);
                        break;
                    }
                };
                let previous = known.len();
                // Scan to a fixed point so rows need not be ordered by depth.
                loop {
                    let before = known.len();
                    for &(pid, parent) in &rows {
                        if Instant::now() >= deadline || known.len() >= 32768 {
                            break;
                        }
                        if known.contains_key(&pid) {
                            continue;
                        }
                        if let Some(&(parent_identity, depth)) = known.get(&parent) {
                            if !still_same(parent_identity) {
                                continue;
                            }
                            if let Some(member) = identity(pid).filter(|p| p.parent == parent) {
                                if !signal(member, libc::SIGSTOP)
                                    && !member.zombie
                                    && still_same(member)
                                {
                                    report.warnings.push(format!("子进程 {pid} 暂停失败"));
                                }
                                known.insert(pid, (member, depth + 1));
                            }
                        }
                    }
                    if known.len() == before || Instant::now() >= deadline || known.len() >= 32768 {
                        break;
                    }
                }
                if known.len() >= 32768 {
                    report.warnings.push("子进程数量超过回收枚举上限".into());
                    break;
                }
                stable = if known.len() == previous {
                    stable + 1
                } else {
                    0
                };
                std::thread::sleep(Duration::from_millis(5));
            }
            if stable < 2 && report.warnings.is_empty() {
                report
                    .warnings
                    .push("子进程树未在限时内稳定，已终止确认的成员".into());
            }
        } else {
            report
                .warnings
                .push("根进程已退出，无法追溯此前已脱离进程组的孤儿进程".into());
        }
        let mut members: Vec<_> = known.into_values().collect();
        members.sort_unstable_by_key(|(_, depth)| std::cmp::Reverse(*depth));
        for (member, _) in members {
            if signal(member, libc::SIGKILL) {
                report.signalled += 1;
            } else if !member.zombie && still_same(member) {
                report
                    .warnings
                    .push(format!("子进程 {} 终止失败", member.pid));
            }
        }
        // Complement the tree walk with the original group: a completed but
        // unreaped root can have reparented group members (probe cleanup).
        // Never target the caller's shared group. An unreaped owned leader
        // retains its PID and proves this is the task's original group.
        if let Some(root) = root.filter(|p| p.group == root_pid && still_same(*p)) {
            unsafe {
                libc::kill(-root.pid, libc::SIGKILL);
            }
            if !report.warnings.is_empty() {
                report
                    .warnings
                    .push("已降级补充终止该任务原进程组；无法保证发现已脱离的成员".into());
            }
        }
        // Child::kill is safe only while the Child has not cached an exit
        // status. With a known root all signals above already covered it.
        if root.is_none() && child.try_wait().ok().flatten().is_none() {
            report
                .warnings
                .push("无法确认根进程身份，未按未经验证的 PID 发送信号".into());
        }
        reap(child, &mut report);
        report
    }
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    use super::*;
    use std::{
        os::unix::process::CommandExt,
        path::PathBuf,
        process::{Command, Stdio},
    };

    struct Owned(Child);
    impl Drop for Owned {
        fn drop(&mut self) {
            let _ = terminate(&mut self.0);
        }
    }

    fn fixture() -> (Owned, Vec<i32>, PathBuf) {
        let file = std::env::temp_dir().join(format!(
            "zhai-process-tree-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let grandchild = "import time; time.sleep(60)";
        let descendant = format!(
            "import os,subprocess,sys,time\np=subprocess.Popen([sys.executable,'-c',{grandchild:?}], start_new_session=True)\nopen(sys.argv[1],'w').write(str(os.getpid())+' '+str(p.pid))\ntime.sleep(60)"
        );
        let root = format!(
            "import subprocess,sys,time\np=subprocess.Popen([sys.executable,'-c',{descendant:?},sys.argv[1]], start_new_session=True)\ntime.sleep(60)"
        );
        let child = Owned(
            Command::new("/usr/bin/python3")
                .args(["-c", &root])
                .arg(&file)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .process_group(0)
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(text) = std::fs::read_to_string(&file) {
                let pids: Vec<i32> = text
                    .split_whitespace()
                    .filter_map(|s| s.parse().ok())
                    .collect();
                if pids.len() == 2 {
                    return (child, pids, file);
                }
            }
            assert!(Instant::now() < deadline, "fixture failed to become ready");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn kills_descendants_in_new_sessions_and_preserves_unrelated_process() {
        let (mut root, pids, file) = fixture();
        let mut outsider = Owned(
            Command::new("/bin/sleep")
                .arg("60")
                .process_group(0)
                .spawn()
                .unwrap(),
        );
        let started = Instant::now();
        let report = terminate(&mut root.0);
        assert!(report.root_reaped, "{report:?}");
        assert!(report.warnings.is_empty(), "{report:?}");
        assert!(report.signalled >= 3, "{report:?}");
        assert!(started.elapsed() < Duration::from_secs(3));
        let deadline = Instant::now() + Duration::from_secs(1);
        while pids
            .iter()
            .any(|pid| unix::identity(*pid).is_some_and(|p| !p.zombie))
            && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(
            pids.iter()
                .all(|pid| unix::identity(*pid).is_none_or(|p| p.zombie)),
            "descendant still running"
        );
        assert!(
            outsider.0.try_wait().unwrap().is_none(),
            "unrelated process was killed"
        );
        let _ = std::fs::remove_file(file);
    }

    #[test]
    fn enumeration_failure_reports_fallback_and_does_not_kill_shared_group() {
        // Deliberately shares the test runner's group. Fallback must not signal
        // that group (which would also kill the test runner and unrelated jobs).
        let mut child = Owned(Command::new("/bin/sleep").arg("60").spawn().unwrap());
        let report = unix::terminate_with_ps(&mut child.0, "/does/not/exist/ps");
        assert!(report.root_reaped, "{report:?}");
        assert!(report.warnings.iter().any(|w| w.contains("枚举")));
        assert!(!report.warnings.iter().any(|w| w.contains("降级")));
    }

    #[test]
    fn exited_unreaped_root_cleans_up_original_group() {
        let file = std::env::temp_dir().join(format!("zhai-orphan-{}", std::process::id()));
        let script = "import subprocess,sys\np=subprocess.Popen(['/bin/sleep','60'])\nopen(sys.argv[1],'w').write(str(p.pid))";
        let mut child = Owned(
            Command::new("/usr/bin/python3")
                .args(["-c", script])
                .arg(&file)
                .process_group(0)
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        while !unix::identity(child.0.id() as i32).is_some_and(|p| p.zombie) {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        let pid: i32 = std::fs::read_to_string(&file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let report = terminate(&mut child.0);
        assert!(report.root_reaped, "{report:?}");
        let deadline = Instant::now() + Duration::from_secs(1);
        while unix::identity(pid).is_some_and(|p| !p.zombie) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(
            unix::identity(pid).is_none_or(|p| p.zombie),
            "orphan still running"
        );
        let _ = std::fs::remove_file(file);
    }

    #[test]
    fn stalled_process_enumeration_is_bounded() {
        use std::os::unix::fs::PermissionsExt;
        let script = std::env::temp_dir().join(format!("zhai-slow-ps-{}", std::process::id()));
        std::fs::write(&script, "#!/bin/sh\nexec /bin/sleep 60\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut child = Owned(
            Command::new("/bin/sleep")
                .arg("60")
                .process_group(0)
                .spawn()
                .unwrap(),
        );
        let started = Instant::now();
        let report = unix::terminate_with_ps(&mut child.0, script.to_str().unwrap());
        assert!(report.root_reaped, "{report:?}");
        assert!(
            report.warnings.iter().any(|w| w.contains("300 毫秒")),
            "{report:?}"
        );
        assert!(started.elapsed() < Duration::from_secs(2));
        let _ = std::fs::remove_file(script);
    }
}
