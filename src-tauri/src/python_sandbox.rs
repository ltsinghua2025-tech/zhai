//! Fail-closed sandbox selection. A binary's presence never implies usability.
use super::*;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    pub available: bool,
    pub backend: Option<String>,
    pub detail: String,
}

#[cfg(any(target_os = "linux", test))]
pub(crate) fn linux_arguments(engine: &Path, workspace: &Path, writable: &[&Path]) -> Vec<String> {
    let mut args = ["--die-with-parent", "--new-session", "--unshare-all", "--cap-drop", "ALL", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "LANG", "C.UTF-8", "--setenv", "HOME", "/tmp", "--setenv", "OPENSSL_armcap", "0", "--setenv", "PYTHONDONTWRITEBYTECODE", "1"].map(str::to_owned).to_vec();
    // Never bind /, /home, /run, D-Bus sockets or the host's /tmp. The one-file
    // sidecar extracts its own bundled Python/dependencies into private /tmp.
    for path in ["/usr/lib", "/usr/lib64", "/lib", "/lib64", "/usr/share/fonts", "/usr/share/mime", "/etc/ld.so.cache", "/etc/mime.types"] {
        if Path::new(path).exists() { args.extend(["--ro-bind".into(), path.into(), path.into()]); }
    }
    fn fonts(root: &Path, current: &Path, paths: &mut Vec<PathBuf>, depth: usize) {
        if depth > 12 || paths.len() >= 8192 { return; }
        let Ok(entries) = fs::read_dir(current) else { return; };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue; };
            if kind.is_symlink() { continue; }
            if kind.is_dir() { fonts(root, &entry.path(), paths, depth + 1); }
            else if kind.is_file() && matches!(entry.path().extension().and_then(|v|v.to_str()).map(str::to_ascii_lowercase).as_deref(), Some("ttf" | "otf" | "ttc" | "otc")) {
                if let Ok(path) = entry.path().canonicalize() { if path.starts_with(root) { paths.push(path); } }
            }
        }
    }
    // User font bytes are an explicit read-only resource, never a HOME bind.
    if let Some(home) = std::env::var_os("HOME") {
        for directory in [PathBuf::from(&home).join(".local/share/fonts"), PathBuf::from(&home).join(".fonts")] {
            if let Ok(root) = directory.canonicalize() {
                let mut paths = Vec::new();
                fonts(&root, &root, &mut paths, 0);
                for path in paths { args.extend(["--ro-bind".into(), path.to_string_lossy().into(), path.to_string_lossy().into()]); }
            }
        }
    }
    for path in [engine, workspace] {
        args.extend(["--ro-bind".into(), path.to_string_lossy().into(), path.to_string_lossy().into()]);
    }
    for path in writable {
        args.extend(["--bind".into(), path.to_string_lossy().into(), path.to_string_lossy().into()]);
    }
    args.extend(["--chdir".into(), workspace.to_string_lossy().into()]);
    args
}

pub(crate) fn command(engine: &Path, workspace: &Path, writable: &[&Path]) -> Result<Command, String> {
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("/usr/bin/sandbox-exec");
        command.env_clear().env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin").env("LANG", "en_US.UTF-8");
        command.arg("-p").arg(macos_python_sandbox_profile(engine, workspace, writable)).arg(engine);
        Ok(command)
    }
    #[cfg(target_os = "linux")]
    {
        // Use a fixed system executable, never an executable in a material dir.
        let bundled = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join("zhai-bwrap"))).filter(|p| p.is_file());
        #[cfg(any(debug_assertions, test))]
        let bundled = bundled.or_else(|| {
            let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
            [manifest.join("binaries/zhai-bwrap-aarch64-unknown-linux-gnu"), manifest.parent().unwrap_or(manifest).join("src-tauri/binaries/zhai-bwrap-aarch64-unknown-linux-gnu")].into_iter().find(|p| p.is_file())
        });
        let bwrap = bundled.or_else(|| ["/usr/bin/bwrap", "/bin/bwrap"].into_iter().find(|p| Path::new(p).is_file()).map(PathBuf::from)).ok_or("[sandbox_unavailable] 未安装 bubblewrap，临时 Python 已禁用；离线成熟能力仍可使用")?;
        let mut version_command = Command::new(&bwrap);
        version_command.arg("--version").env_clear().stdin(Stdio::null());
        let version = process_runner::run(&mut version_command, &AtomicBool::new(false), Duration::from_secs(3), |_| {})?;
        let version_text = String::from_utf8_lossy(&version.stdout);
        let supported = version_text.split_whitespace().find(|v| v.chars().next().is_some_and(|c| c.is_ascii_digit())).and_then(|v| {
            let mut parts = v.split('.').filter_map(|p| p.parse::<u32>().ok());
            Some((parts.next()?, parts.next()?))
        }).is_some_and(|(major, minor)| major > 0 || minor >= 12);
        if !version.status.success() || !supported { return Err("[sandbox_unavailable] bubblewrap 版本未满足已修复隔离漏洞的 0.12.0 最低要求，临时 Python 已禁用".into()); }
        let mut command = Command::new(bwrap);
        command.env_clear();
        command.args(linux_arguments(engine, workspace, writable)).arg("--").arg(engine);
        Ok(command)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    { let _ = (engine, workspace, writable); Err("[sandbox_unavailable] 此平台没有经过验证的临时代码隔离器".into()) }
}

fn probe() -> Result<Status, String> {
    let engine = bundled_binary_path("material-workshop-engine").ok_or("[sandbox_unavailable] 缺少应用自带 Python 引擎")?;
    let root = std::env::temp_dir().join(format!("zhai-sandbox-probe-{}", Uuid::new_v4()));
    let result = (|| {
        let workspace = root.join("workspace");
        let input = workspace.join("inputs");
        let output = workspace.join("outputs");
        let runtime = workspace.join("runtime");
        for path in [&input, &output, &runtime] { fs::create_dir_all(path).map_err(|e| e.to_string())?; }
        fs::write(input.join("readonly.txt"), "protected").map_err(|e| e.to_string())?;
        let forbidden = root.join("private.txt");
        fs::write(&forbidden, "private").map_err(|e| e.to_string())?;
        let script = workspace.join("probe.py");
        // Exercise the same packaged engine and mount policy as real scripts.
        // Do not count mere bwrap --version or unshare success as availability.
        fs::write(&script, format!(r#"def run(context):
    import socket, subprocess
    import docx, docxcompose, openpyxl, pypdf, pdfplumber, reportlab, lxml
    from pathlib import Path
    for path, mode in [(Path({forbidden}), 'r'), (context.inputs[0], 'w')]:
        try:
            with path.open(mode): pass
        except OSError: pass
        else: raise RuntimeError('sandbox filesystem boundary failed')
    s = socket.socket()
    s.settimeout(0.3)
    try: s.connect(('1.1.1.1', 443))
    except OSError: pass
    else: raise RuntimeError('sandbox network boundary failed')
    finally: s.close()
    path = context.output_dir / 'probe.txt'
    path.write_text('ok')
    return {{'summary':'sandbox_probe_ok','outputs':[str(path)]}}
"#, forbidden = json!(forbidden).to_string())).map_err(|e| e.to_string())?;
        let request = workspace.join("request.json");
        write_json_atomic(&request, &json!({"schemaVersion":1,"neverOverwrite":true,"scriptPath":script,"inputDirectory":input,"outputDirectory":output}))?;
        let mut command = command(&engine, &workspace, &[&runtime, &output])?;
        command.arg("--run-agent-script").arg(request).env("TMPDIR", &runtime).stdin(Stdio::null());
        let output = process_runner::run(&mut command, &AtomicBool::new(false), Duration::from_secs(15), |_| {})?;
        if fs::read_to_string(input.join("readonly.txt")).ok().as_deref() != Some("protected") || fs::read_to_string(&forbidden).ok().as_deref() != Some("private") { return Err("[sandbox_unavailable] 隔离探测发现文件保护失败".into()); }
        if !output.status.success() || !String::from_utf8_lossy(&output.stdout).contains("sandbox_probe_ok") {
            return Err(format!("[sandbox_unavailable] 隔离器实际探测失败，临时 Python 已禁用：{}", String::from_utf8_lossy(&output.stderr).lines().take(3).collect::<Vec<_>>().join("；")));
        }
        Ok(Status { available: true, backend: Some(if cfg!(target_os = "linux") { "bubblewrap" } else { "sandbox-exec" }.into()), detail: "应用自带 Python 依赖、材料只读、独立输出可写及断网探测通过".into() })
    })();
    let _ = fs::remove_dir_all(&root);
    result
}

pub(crate) fn status() -> Status {
    static STATUS: OnceLock<Status> = OnceLock::new();
    STATUS.get_or_init(|| probe().unwrap_or_else(|detail| Status { available: false, backend: None, detail })).clone()
}

pub(crate) fn require() -> Result<(), String> {
    let status = status();
    if status.available { Ok(()) } else { Err(status.detail) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn linux_policy_is_private_and_fail_closed() {
        let args = linux_arguments(Path::new("/opt/zhai/engine"), Path::new("/work"), &[Path::new("/work/out")]);
        assert!(args.contains(&"--unshare-all".into()));
        assert!(args.contains(&"--new-session".into()));
        assert!(!args.contains(&"--share-net".into()));
        assert!(!args.iter().any(|v| v == "/home" || v == "/run" || v == "/"));
        let bindings = args.windows(3).filter(|v| v[0] == "--bind").collect::<Vec<_>>();
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0][1], "/work/out");
    }
}
