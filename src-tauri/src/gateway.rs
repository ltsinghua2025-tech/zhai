//! Verify the Responses features used by Codex with a synthetic, file-free tool round trip.
use super::{AiProfile, skill_design};
use parking_lot::Mutex;
use reqwest::{Client, StatusCode, redirect::Policy};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{
    Arc, OnceLock,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};
use uuid::Uuid;

const TOOL: &str = "zhai_probe";
const CACHE_TIME: Duration = Duration::from_secs(15 * 60);
const MAX_SSE_BYTES: usize = 256 * 1024;

#[derive(Clone)]
pub(super) enum AgentRoute {
    Codex,
    Structured(&'static str),
}

// Changing the account, model, or base URL requires a new capability check.
// Neither API credentials nor the probes are written to disk.
type Cache = Mutex<HashMap<[u8; 32], (Instant, AgentRoute)>>;
static CACHE: OnceLock<Cache> = OnceLock::new();

pub(super) async fn agent_route(
    profile: &AiProfile,
    model: &str,
    key: &str,
    stop: Arc<AtomicBool>,
) -> Result<AgentRoute, String> {
    if stop.load(Ordering::SeqCst) {
        return Err("已停止网关能力检查".into());
    }
    let base = profile.base_url.trim_end_matches('/');
    let cache_key: [u8; 32] =
        Sha256::digest(serde_json::to_vec(&(base, model, key)).unwrap()).into();
    let cache = CACHE.get_or_init(Mutex::default);
    if let Some((_, route)) = cache
        .lock()
        .get(&cache_key)
        .filter(|(at, _)| at.elapsed() < CACHE_TIME)
    {
        return Ok(route.clone());
    }
    let route = tokio::select! {
        biased;
        _ = skill_design::wait_for_cancellation(stop) => return Err("已停止网关能力检查".into()),
        result = probe(base, model, key) => result?,
    };
    let mut entries = cache.lock();
    entries.retain(|_, (at, _)| at.elapsed() < CACHE_TIME);
    entries.insert(cache_key, (Instant::now(), route.clone()));
    Ok(route)
}

enum Reply {
    Output(Vec<Value>),
    Unsupported(&'static str),
}

async fn probe(base: &str, model: &str, key: &str) -> Result<AgentRoute, String> {
    let client = Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(40))
        .build()
        .map_err(|e| e.to_string())?;
    let endpoint = format!("{base}/responses");
    let user = json!({"role":"user","content":"Call zhai_probe exactly once. After receiving its result, reply with that token exactly."});
    let tool = json!({"type":"function","name":TOOL,"description":"Returns a synthetic connectivity token.",
        "parameters":{"type":"object","properties":{},"additionalProperties":false}});
    let request = |input: Vec<Value>| json!({"model":model,"input":input,"tools":[tool],"stream":true,"store":false});
    let first = match call(&client, &endpoint, key, &request(vec![user.clone()])).await? {
        Reply::Unsupported(reason) => return Ok(AgentRoute::Structured(reason)),
        Reply::Output(items) => items,
    };
    let mut calls = first.iter().filter(|i| i["type"] == "function_call");
    let Some(id) = calls
        .next()
        .filter(|i| i["name"] == TOOL)
        .and_then(|i| i["call_id"].as_str())
        .filter(|id| !id.is_empty() && calls.next().is_none())
    else {
        return Ok(AgentRoute::Structured(
            "模型没有返回可执行的 Responses 工具调用",
        ));
    };
    let token = format!("zhai-{}", Uuid::new_v4().simple());
    let result = json!({"type":"function_call_output","call_id":id,"output":token});
    let mut input = vec![user];
    // Codex resends the complete history, including reasoning, to stateless gateways.
    input.extend(first);
    input.push(result);
    match call(&client, &endpoint, key, &request(input)).await? {
        Reply::Output(items)
            if items
                .iter()
                .filter(|i| i["type"] == "message")
                .filter_map(|i| i["content"].as_array())
                .flatten()
                .any(|c| {
                    c["type"] == "output_text"
                        && c["text"].as_str().is_some_and(|s| s.contains(&token))
                }) =>
        {
            Ok(AgentRoute::Codex)
        }
        Reply::Output(_) => Ok(AgentRoute::Structured("模型未确认收到工具执行结果")),
        Reply::Unsupported(reason) => Ok(AgentRoute::Structured(reason)),
    }
}

fn network_error(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "网关能力检查超时，请稍后重试".into()
    } else {
        format!("无法完成网关能力检查：{}", e.without_url())
    }
}

async fn call(client: &Client, endpoint: &str, key: &str, body: &Value) -> Result<Reply, String> {
    let mut response = client
        .post(endpoint)
        .bearer_auth(key)
        .json(body)
        .send()
        .await
        .map_err(network_error)?;
    let status = response.status();
    if matches!(
        status,
        StatusCode::NOT_FOUND
            | StatusCode::METHOD_NOT_ALLOWED
            | StatusCode::NOT_IMPLEMENTED
            | StatusCode::UNSUPPORTED_MEDIA_TYPE
    ) {
        return Ok(Reply::Unsupported("网关未提供 Responses 工具接口"));
    }
    if !status.is_success() {
        if matches!(
            status,
            StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY
        ) {
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(network_error)? {
                if bytes.len() + chunk.len() > 8192 {
                    break;
                }
                bytes.extend_from_slice(&chunk);
            }
            let lower = String::from_utf8_lossy(&bytes).to_ascii_lowercase();
            if [
                "tool",
                "function_call",
                "unsupported endpoint",
                "not supported",
                "not implemented",
                "不支持",
            ]
            .iter()
            .any(|pattern| lower.contains(pattern))
            {
                return Ok(Reply::Unsupported("网关拒绝了 Responses 工具协议"));
            }
        }
        return Err(format!(
            "网关能力检查返回 HTTP {}。请核对服务地址、模型、密钥或额度后重试",
            status.as_u16()
        ));
    }
    if !response
        .headers()
        .get("content-type")
        .and_then(|s| s.to_str().ok())
        .is_some_and(|s| s.to_ascii_lowercase().starts_with("text/event-stream"))
    {
        return Ok(Reply::Unsupported("网关未返回 Responses 流式事件"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if bytes.len() + chunk.len() > MAX_SSE_BYTES {
            return Err("网关能力检查响应超出上限".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    parse_events(&bytes)
}

fn parse_events(bytes: &[u8]) -> Result<Reply, String> {
    let mut completed_items = Vec::new();
    for line in String::from_utf8_lossy(bytes).lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let Ok(event) = serde_json::from_str::<Value>(data.trim()) else {
            continue;
        };
        match event["type"].as_str() {
            Some("response.output_item.done") => completed_items.push(event["item"].clone()),
            Some("response.completed") => {
                let items = event["response"]["output"]
                    .as_array()
                    .filter(|a| !a.is_empty())
                    .cloned()
                    .unwrap_or(completed_items);
                return Ok(Reply::Output(items));
            }
            Some("response.failed" | "error" | "response.incomplete") => {
                return Err("网关未完成 Responses 能力检查，请稍后重试".into());
            }
            _ => {}
        }
    }
    Err("网关的 Responses 连接提前结束，请重试".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;

    #[tokio::test]
    async fn compatible_profile_requires_real_tool_result_and_retries_transient_status() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for index in 0..4 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                assert!(reader.read_line(&mut line).unwrap() > 0);
                assert!(line.starts_with("POST /v1/responses "));
                let mut length = 0;
                loop {
                    line.clear();
                    reader.read_line(&mut line).unwrap();
                    if line.trim().is_empty() {
                        break;
                    }
                    if let Some(n) = line.to_lowercase().strip_prefix("content-length:") {
                        length = n.trim().parse::<usize>().unwrap();
                    }
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                let value: Value = serde_json::from_slice(&body).unwrap();
                let (status, body) = match index {
                    0 => ("429 Too Many Requests", String::new()),
                    1 | 2 => {
                        assert_eq!(value["tools"][0]["name"], TOOL);
                        let items = if index == 1 {
                            json!([{"type":"function_call","name":TOOL,"call_id":"abc","arguments":"{}"}])
                        } else {
                            let result = value["input"].as_array().unwrap().last().unwrap();
                            assert_eq!(result["call_id"], "abc");
                            json!([{"type":"message","content":[{"type":"output_text","text":result["output"]}]}])
                        };
                        (
                            "200 OK",
                            format!(
                                "data: {}\n\n",
                                json!({"type":"response.completed","response":{"output":items}})
                            ),
                        )
                    }
                    _ => ("404 Not Found", String::new()),
                };
                write!(stream, "HTTP/1.1 {status}\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
        });
        let profile = AiProfile {
            id: "probe".into(),
            provider: "openai_compatible".into(),
            display_name: "test".into(),
            base_url: format!("http://{address}/v1"),
            default_model: "a".into(),
            key_stored: false,
            last_test: None,
        };
        let flag = Arc::new(AtomicBool::new(false));
        assert!(
            agent_route(&profile, "a", "test", flag.clone())
                .await
                .is_err()
        );
        assert!(matches!(
            agent_route(&profile, "a", "test", flag.clone()).await,
            Ok(AgentRoute::Codex)
        ));
        assert!(matches!(
            agent_route(&profile, "a", "test", flag.clone()).await,
            Ok(AgentRoute::Codex)
        ));
        assert!(matches!(
            agent_route(&profile, "b", "test", flag).await,
            Ok(AgentRoute::Structured(_))
        ));
        assert!(
            agent_route(&profile, "a", "test", Arc::new(AtomicBool::new(true)))
                .await
                .is_err()
        );
        server.join().unwrap();
    }
    #[test]
    fn supports_both_sse_spacing_styles_and_separately_finished_items() {
        let bytes = b"event:response.output_item.done\ndata:{\"type\":\"response.output_item.done\",\"item\":{\"type\":\"function_call\",\"call_id\":\"a\"}}\r\n\r\ndata: {\"type\":\"response.completed\",\"response\":{\"output\":[]}}\n\n";
        assert!(
            matches!(parse_events(bytes), Ok(Reply::Output(items)) if items[0]["call_id"] == "a")
        );
        assert!(parse_events(b"data: {\"type\":\"response.created\"}\n").is_err());
    }
}
