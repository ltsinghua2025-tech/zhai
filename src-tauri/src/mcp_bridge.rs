//! Local, turn-scoped MCP transport. The stdio child is only a proxy: all tools
//! run in the application's existing executor, with its session and permissions.
use serde_json::{Value, json};
#[cfg(unix)]
use std::os::unix::{
    fs::PermissionsExt,
    net::{UnixListener, UnixStream},
};
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

const MAX_REQUEST: usize = 1024 * 1024;
fn read_message(reader: impl Read) -> Result<Value, String> {
    let mut bytes = Vec::new();
    BufReader::new(reader)
        .take((MAX_REQUEST + 1) as u64)
        .read_until(b'\n', &mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > MAX_REQUEST {
        return Err("工具请求超过大小限制".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "工具请求不是有效 JSON".into())
}

pub(crate) struct Endpoint {
    pub path: PathBuf,
    pub token: String,
}

pub(crate) fn rpc(
    request: Value,
    dispatch: &impl Fn(&str, Value) -> Result<Value, String>,
    tools: &Value,
) -> Option<Value> {
    let id = request.get("id")?.clone();
    let method = request["method"].as_str().unwrap_or("");
    let result = match method {
        "initialize" => {
            let requested = request["params"]["protocolVersion"]
                .as_str()
                .unwrap_or("2024-11-05");
            let version = if ["2024-11-05", "2025-03-26", "2025-06-18"].contains(&requested) {
                requested
            } else {
                "2025-06-18"
            };
            Ok(
                json!({"protocolVersion":version,"capabilities":{"tools":{}},"serverInfo":{"name":"zhai-files","version":env!("CARGO_PKG_VERSION")},"instructions":"先查找成熟能力，再运行。只使用 tools/list 实际提供的工具；未提供 run_python 时不得绕过隔离器或反复尝试。Word 结构读取/定位编辑用相应工具。输入只用 list_materials 返回的 ID 或工具输出 ID。工具结果为暂存成果，最终必须调用 deliver 选择用户所需文件。失败先检查错误，禁止原样反复重试。"}),
            )
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools":tools})),
        "tools/call" => {
            let name = request["params"]["name"].as_str().unwrap_or("");
            let arguments = request["params"]
                .get("arguments")
                .cloned()
                .unwrap_or(json!({}));
            let (value, failed) = match dispatch(name, arguments) {
                Ok(v) => (v, false),
                Err(e) => (json!({"error":e,"success":false}), true),
            };
            Ok(
                json!({"content":[{"type":"text","text":value.to_string()}],"structuredContent":value,"isError":failed}),
            )
        }
        _ => Err(json!({"code":-32601,"message":"Unknown method"})),
    };
    Some(match result {
        Ok(v) => json!({"jsonrpc":"2.0","id":id,"result":v}),
        Err(e) => json!({"jsonrpc":"2.0","id":id,"error":e}),
    })
}

#[cfg(unix)]
pub(crate) fn with_server<T>(
    tools: Value,
    dispatch: impl Fn(&str, Value) -> Result<Value, String> + Sync,
    body: impl FnOnce(&Endpoint) -> Result<T, String>,
) -> Result<T, String> {
    // Keep socket paths short enough for sockaddr_un on macOS.
    let directory = PathBuf::from("/tmp").join(format!("zhai-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir(&directory).map_err(|e| e.to_string())?;
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| e.to_string())?;
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Cleanup(directory.clone());
    let endpoint = Endpoint {
        path: directory.join("mcp.sock"),
        token: uuid::Uuid::new_v4().to_string(),
    };
    let listener = UnixListener::bind(&endpoint.path).map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let stopped = AtomicBool::new(false);
    std::thread::scope(|scope| {
        struct StopOnDrop<'a>(&'a AtomicBool);
        impl Drop for StopOnDrop<'_> {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let _stop = StopOnDrop(&stopped);
        scope.spawn(|| {
            while !stopped.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut connection, _)) => {
                        // BSD/macOS may inherit O_NONBLOCK from the listener.
                        // A fragmented JSON write must wait for its newline.
                        let _ = connection.set_nonblocking(false);
                        let _ = connection.set_read_timeout(Some(Duration::from_secs(2)));
                        let _ = connection.set_write_timeout(Some(Duration::from_secs(2)));
                        if let Ok(envelope) = read_message(&connection) {
                            if envelope["token"].as_str() != Some(endpoint.token.as_str()) {
                                continue;
                            }
                            let response = rpc(envelope["request"].clone(), &dispatch, &tools)
                                .unwrap_or(Value::Null);
                            let _ = writeln!(connection, "{response}");
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(20))
                    }
                    Err(_) => break,
                }
            }
        });
        let result = body(&endpoint);
        stopped.store(true, Ordering::SeqCst);
        result
    })
}

#[cfg(not(unix))]
pub(crate) fn with_server<T>(
    _tools: Value,
    _dispatch: impl Fn(&str, Value) -> Result<Value, String> + Sync,
    _body: impl FnOnce(&Endpoint) -> Result<T, String>,
) -> Result<T, String> {
    Err("当前平台尚未实现本地能力桥接".into())
}

pub fn run_stdio(path: &Path) -> Result<(), String> {
    #[cfg(not(unix))]
    {
        let _ = path;
        return Err("当前平台尚未实现本地能力桥接".into());
    }
    #[cfg(unix)]
    {
        let token = std::env::var("ZHAI_MCP_TOKEN").map_err(|_| "缺少工具会话凭据")?;
        let stdin = std::io::stdin();
        let mut reader = stdin.lock();
        let mut stdout = std::io::stdout().lock();
        loop {
            let mut bytes = Vec::new();
            (&mut reader)
                .take((MAX_REQUEST + 1) as u64)
                .read_until(b'\n', &mut bytes)
                .map_err(|e| e.to_string())?;
            if bytes.is_empty() {
                return Ok(());
            }
            if bytes.len() > MAX_REQUEST {
                return Err("工具请求超过大小限制".into());
            }
            let request: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            if request.get("id").is_none() {
                continue;
            }
            let mut connection = UnixStream::connect(path).map_err(|_| "本轮工具会话已结束")?;
            connection
                .set_read_timeout(Some(Duration::from_secs(600)))
                .map_err(|e| e.to_string())?;
            writeln!(connection, "{}", json!({"token":token,"request":request}))
                .map_err(|e| e.to_string())?;
            let response = read_message(&connection)?;
            writeln!(stdout, "{response}").map_err(|e| e.to_string())?;
            stdout.flush().map_err(|e| e.to_string())?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn protocol_handles_discovery_errors_and_notifications() {
        let dispatch = |_: &str, _: Value| Err("需要修改参数".into());
        assert!(
            rpc(
                json!({"method":"notifications/initialized"}),
                &dispatch,
                &json!([])
            )
            .is_none()
        );
        let init = rpc(
            json!({"id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}),
            &dispatch,
            &json!([]),
        )
        .unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2024-11-05");
        let error = rpc(
            json!({"id":2,"method":"tools/call","params":{"name":"run_skill"}}),
            &dispatch,
            &json!([]),
        )
        .unwrap();
        assert_eq!(error["result"]["isError"], true);
        assert_eq!(error["id"], 2);
    }

    #[test]
    #[cfg(unix)]
    fn local_transport_dispatches_and_cleans_up() {
        let mut socket = PathBuf::new();
        with_server(json!([]), |name, args| Ok(json!({"name":name,"arguments":args})), |endpoint| {
            socket = endpoint.path.clone();
            let mut stream = UnixStream::connect(&endpoint.path).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let request = json!({"token":endpoint.token,"request":{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_materials","arguments":{}}}}).to_string();
            let middle = request.len()/2;
            stream.write_all(&request.as_bytes()[..middle]).unwrap();
            std::thread::sleep(Duration::from_millis(50));
            stream.write_all(&request.as_bytes()[middle..]).unwrap();
            stream.write_all(b"\n").unwrap();
            assert_eq!(read_message(stream).unwrap()["result"]["structuredContent"]["name"], "list_materials");
            Ok(())
        }).unwrap();
        assert!(!socket.exists());
    }
}
