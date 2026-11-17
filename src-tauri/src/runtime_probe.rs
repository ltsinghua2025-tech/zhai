//! Bounded, coalesced discovery. A probe is a hint; execution still validates
//! the selected adapter and its output. Nothing is persisted across launches.
use super::*;

type ProbeResult = Result<Vec<u8>, String>;
#[derive(Default)]
struct Entry {
    value: Option<(Instant, ProbeResult)>,
}
#[derive(Default)]
struct Cache(Mutex<HashMap<String, Arc<Mutex<Entry>>>>);

impl Cache {
    #[cfg(test)]
    fn get(&self, key: String, probe: impl FnOnce() -> ProbeResult) -> ProbeResult {
        self.get_with_ttl(key, Duration::from_secs(30), probe)
    }

    fn get_with_ttl(&self, key: String, success_ttl: Duration, probe: impl FnOnce() -> ProbeResult) -> ProbeResult {
        let entry = self.0.lock().entry(key).or_default().clone();
        // One process per key even when UI and Agent request it together.
        let mut entry = entry.lock();
        if let Some((at, value)) = &entry.value {
            let ttl = if value.is_ok() { success_ttl } else { Duration::from_secs(2) };
            if at.elapsed() < ttl {
                return value.clone();
            }
        }
        let result = probe();
        entry.value = Some((Instant::now(), result.clone()));
        result
    }
}

pub(super) fn output(executable: &Path, args: &[&str]) -> ProbeResult {
    output_validated(executable, args, false, Duration::from_secs(5), Duration::from_secs(30))
}

pub(super) fn json(executable: &Path, args: &[&str]) -> Result<Value, String> {
    let bytes = output_validated(executable, args, true, Duration::from_secs(5), Duration::from_secs(30))?;
    serde_json::from_slice(&bytes).map_err(|_| "组件探测没有返回有效 JSON".into())
}

// OCR must unpack its isolated runtime and load models on a cold start. Keep
// this distinct from lightweight office probes; no ordinary file task pays it.
pub(super) fn ocr_json(executable: &Path) -> Result<Value, String> {
    let bytes = output_validated(executable, &["--probe"], true,
        Duration::from_secs(30), Duration::from_secs(300))?;
    serde_json::from_slice(&bytes).map_err(|_| "OCR 探测没有返回有效 JSON".into())
}

fn output_validated(executable: &Path, args: &[&str], require_json: bool, timeout: Duration, success_ttl: Duration) -> ProbeResult {
    static CACHE: OnceLock<Cache> = OnceLock::new();
    // Replacing an executable invalidates its previous result immediately.
    let metadata = fs::metadata(executable).ok();
    let key = format!("{require_json}:{timeout:?}:{success_ttl:?}:{:?}:{:?}:{:?}:{:?}", executable, args,
        metadata.as_ref().map(|m| m.len()),
        metadata.and_then(|m| m.modified().ok()));
    CACHE.get_or_init(Cache::default).get_with_ttl(key, success_ttl, || {
        let mut command = Command::new(executable);
        command.args(args).stdin(Stdio::null());
        let output = process_runner::run_probe(&mut command, timeout)?;
        if !output.status.success() {
            return Err("组件探测失败；执行能力暂不可用".into());
        }
        if output.stdout.is_empty() || output.stdout.len() >= 256 * 1024 {
            return Err("组件探测返回空内容或内容过长".into());
        }
        if require_json {
            let value: Value = serde_json::from_slice(&output.stdout)
                .map_err(|_| "组件探测没有返回有效 JSON".to_string())?;
            if !value.get("capabilities").is_some_and(Value::is_object) {
                return Err("组件探测缺少 capabilities 对象".into());
            }
        }
        Ok(output.stdout)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn concurrent_discovery_runs_one_probe_and_keys_do_not_mix() {
        let cache = Arc::new(Cache::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let threads = (0..8).map(|_| {
            let cache = cache.clone();
            let calls = calls.clone();
            std::thread::spawn(move || cache.get("same".into(), || {
                calls.fetch_add(1, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(20));
                Ok(b"ready".to_vec())
            }).unwrap())
        }).collect::<Vec<_>>();
        for thread in threads { assert_eq!(thread.join().unwrap(), b"ready"); }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(cache.get("other".into(), || Ok(b"other".to_vec())).unwrap(), b"other");
    }

    #[test]
    fn expired_failure_is_retried() {
        let cache = Cache::default();
        assert!(cache.get("probe".into(), || Err("not ready".into())).is_err());
        cache.0.lock()["probe"].lock().value.as_mut().unwrap().0 =
            Instant::now() - Duration::from_secs(3);
        assert_eq!(cache.get("probe".into(), || Ok(b"ready".to_vec())).unwrap(), b"ready");
    }

    #[test]
    fn hanging_component_has_a_deadline() {
        let start = Instant::now();
        let result = output(Path::new("/usr/bin/python3"), &["-c", "import time; time.sleep(60)"]);
        assert!(result.unwrap_err().contains("超时"));
        assert!(start.elapsed() < Duration::from_secs(8));
    }

    #[test]
    fn successful_probe_does_not_leave_a_background_writer() {
        let marker = std::env::temp_dir().join(format!("zhai-probe-{}.txt", Uuid::new_v4()));
        let child = format!("import time; time.sleep(0.8); open({}, 'w').write('leaked')", json!(marker.to_string_lossy()));
        let script = format!("import subprocess,sys; subprocess.Popen([sys.executable,'-c',{}]); print('ready', flush=True)", json!(child));
        assert_eq!(output(Path::new("/usr/bin/python3"), &["-c", &script]).unwrap(), b"ready\n");
        std::thread::sleep(Duration::from_millis(1100));
        let leaked = marker.exists();
        let _ = fs::remove_file(marker);
        assert!(!leaked, "successful discovery left a background process");
    }
}
