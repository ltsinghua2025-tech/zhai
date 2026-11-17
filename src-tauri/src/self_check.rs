//! Deterministic, isolated desktop smoke test. Uses the shipped sidecar and the
//! real Rust executor without touching user sessions or requiring a model.
use super::*;
struct Events;
impl EventSink<SkillDesignEvent> for Events {
    fn send(&self, event: SkillDesignEvent) -> Result<(), String> {
        eprintln!(
            "设计事件：{}",
            serde_json::to_string(&event).map_err(|e| e.to_string())?
        );
        Ok(())
    }
}
impl EventSink<SkillRunEvent> for Events {
    fn send(&self, _: SkillRunEvent) -> Result<(), String> {
        Ok(())
    }
}
impl EventSink<AgentEvent> for Events {
    fn send(&self, _: AgentEvent) -> Result<(), String> {
        Ok(())
    }
}

/// Explicitly opted-in live design check; real credentials are read through the
/// existing keychain profile, while all skill/library state stays isolated.
pub(super) fn design(app: &AppHandle, root: &Path) -> Result<Value, String> {
    eprintln!("真实能力设计自检目录：{}", root.display());
    // Same opt-in, non-persistent stdin credential path as the online check.
    // This is only a test runner input; normal UI still uses Keychain.
    let session_key = if std::env::args().any(|a| a == "--self-check-key-stdin") {
        let mut value = String::new();
        std::io::stdin().read_line(&mut value).map_err(|e| e.to_string())?;
        let value = value.trim().to_owned();
        if value.is_empty() { return Err("联网自检缺少本次密钥".into()); }
        Some(value)
    } else { None };
    let source = Connection::open_with_flags(
        app_data_directory(app)?.join("history.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| e.to_string())?;
    let (id, name, url, model): (String, String, String, String) = source.query_row(
        "SELECT id,display_name,base_url,default_model FROM ai_profiles WHERE provider='deepseek' AND key_stored=1 ORDER BY last_test_success DESC,id LIMIT 1", [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    ).map_err(|_| "没有已保存的 DeepSeek 配置")?;
    drop(source);
    let state = AppState::open(root.join("design-data"))?;
    state.db.lock().execute("INSERT INTO ai_profiles(id,provider,display_name,base_url,default_model,key_stored) VALUES(?1,'deepseek',?2,?3,?4,1)", params![id,name,url,model]).map_err(|e|e.to_string())?;
    app.manage(state);
    let state = app.state::<AppState>();
    if std::env::args().any(|a| a == "--self-check-design-resume") {
        return design_resume_check(&state, &id, &model, root, session_key.as_deref());
    }
    let first = root.join("首批Word");
    let second = root.join("换文件夹");
    let empty = root.join("empty");
    fs::create_dir_all(&empty).map_err(|e| e.to_string())?;
    for (folder, prefix, count) in [(&first, "首批", 3), (&second, "第二批", 2)] {
        fs::create_dir_all(folder).map_err(|e| e.to_string())?;
        let script = root.join(format!("fixtures-{count}.py"));
        fs::write(&script, "from docx import Document\ndef run(context, params):\n    outputs=[]\n    for i in range(params['count']):\n        d=Document()\n        d.add_paragraph(params['prefix']+str(i+1))\n        d.add_paragraph('必须保留的加粗内容').runs[0].bold=True\n        t=d.add_table(rows=2,cols=2)\n        t.cell(0,0).text='项目'\n        t.cell(0,1).text='数量'\n        t.cell(1,0).text=params['prefix']+str(i+1)\n        t.cell(1,1).text=str(10+i)\n        p=context.output_dir / ('%02d.docx'%(i+1))\n        d.save(p)\n        outputs.append(str(p))\n    return {'summary':'fixtures','outputs':outputs}\n").map_err(|e|e.to_string())?;
        let request = root.join("fixture-request.json");
        write_json_atomic(
            &request,
            &json!({"schemaVersion":1,"neverOverwrite":true,"scriptPath":script,"inputDirectory":empty,"outputDirectory":folder,"parameters":{"prefix":prefix,"count":count}}),
        )?;
        let output = engine_command()?
            .arg("--run-agent-script")
            .arg(request)
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).into());
        }
    }
    let hashes = [hash_skill_package(&first)?, hash_skill_package(&second)?];
    let request = DesignToolRequest {
        design_id: Some("word-merge-check".into()), current_skill_id: None,
        prompt: "设计一个可复用的‘文件夹 Word 合并’离线能力：把每次所选文件夹的全部 DOCX 按文件名升序合并成一个 Word，各文件之间分页，保留全文、表格及原有加粗。原件只读。输入支持本次全部材料，不要写死样本名称或路径。普通 DOCX 无页眉页脚；遇到无法保真的复杂结构或旧 DOC 应明确提示，不可悄悄丢掉。完善能力契约、说明和样本验收规则。".into(),
        profile_id: id, model, api_key: session_key, kind: Some("python".into()),
        attachments: vec![DesignAttachment {path:first.to_string_lossy().into(),role:"sample_input".into()}],
    };
    // Re-run the exact package that exposed a runtime failure without asking
    // the model to generate a different implementation that happens to pass.
    let tool = if let Some(package) = std::env::var_os("ZHAI_SELF_CHECK_DESIGNED_PACKAGE") {
        load_designed_package(&PathBuf::from(package))?
    } else {
        tauri::async_runtime::block_on(design_agent_tool_inner(request, &state, &Events))?
    };
    let tool = save_agent_tool(tool, app.state())?;
    if publish_skill(tool.id.clone(), app.state()).is_ok() {
        return Err("未测试的草稿被发布".into());
    }
    let tested = test_skill(
        TestSkillRequest {
            skill_id: tool.id.clone(),
            sample_paths: (1..=3)
                .map(|i| first.join(format!("{i:02}.docx")).to_string_lossy().into())
                .collect(),
            parameters: json!({}),
        },
        app.clone(),
        app.state(),
    )?;
    if tested.test_status.as_deref() != Some("passed") {
        return Err(format!("实际样本测试失败：{}", tested.availability_detail));
    }
    let published = publish_skill(tool.id.clone(), app.state())?;
    let mut outputs = Vec::new();
    for (folder, prefix, count) in [(&first, "首批", 3), (&second, "第二批", 2)] {
        let result = run_skill_inner(
            RunSkillRequest {
                run_id: Uuid::new_v4().to_string(),
                skill_id: tool.id.clone(),
                paths: vec![folder.to_string_lossy().into()],
                parameters: json!({}),
            },
            app.clone(),
            &state,
            &Events,
        )?;
        let paths = artifact_paths(&result.artifacts);
        if paths.len() != 1 || paths[0].extension().and_then(|s| s.to_str()) != Some("docx") {
            return Err("合并必须仅交付一个 DOCX".into());
        }
        let session =
            create_pipeline_session(&state, &root.join(format!("verify-{count}")), &paths)?;
        execute_dynamic_python_scoped(
            &state,
            &session,
            "verify",
            "from docx import Document\nfrom docx.oxml.ns import qn\ndef run(context, params):\n    d=Document(context.inputs[0])\n    expected=[params['prefix']+str(i+1) for i in range(params['count'])]\n    titles=[p.text for p in d.paragraphs if p.text.startswith(params['prefix'])]\n    assert titles==expected, ('文件顺序或正文错误',titles,expected)\n    assert len(d.tables)==params['count'], ('表格缺失',len(d.tables))\n    assert [t.cell(1,0).text for t in d.tables]==expected\n    assert sum(1 for p in d.paragraphs if p.text=='必须保留的加粗内容' and any(r.bold for r in p.runs))==params['count'], '加粗内容丢失'\n    assert len(d.element.xpath('//w:br[@w:type=\"page\"]'))+sum(1 for p in d.paragraphs if p.paragraph_format.page_break_before)>=params['count']-1, '分页丢失'\n    return {'summary':'全文、顺序、表格、加粗及分页通过','outputs':[]}\n",
            Some(&json!({"prefix":prefix,"count":count})),
            Arc::new(AtomicBool::new(false)),
            None,
            false,
            true,
        )?;
        outputs.extend(paths);
    }
    if hashes != [hash_skill_package(&first)?, hash_skill_package(&second)?] {
        return Err("原件哈希变化".into());
    }
    Ok(
        json!({"success":true,"root":root,"skillId":published.id,"packagePath":published.package_path,"reusedPackage":std::env::var_os("ZHAI_SELF_CHECK_DESIGNED_PACKAGE").is_some(),"checks":["真实 DeepSeek 生成能力包（复测时沿用同一包）","未测试禁止发布","正式执行器样本测试","发布能力","首批三份与新文件夹两份独立复用","重新打开核对全文、顺序、表格、加粗与分页","原件哈希不变"],"outputs":outputs}),
    )
}

fn design_resume_check(state: &AppState, profile_id: &str, model: &str, root: &Path, session_key: Option<&str>) -> Result<Value, String> {
    let profile = get_ai_profile(state, profile_id)?;
    let api_key = resolve_api_key(profile_id, session_key)?;
    let workspace = root.join("resume-package");
    fs::create_dir_all(&workspace).map_err(|e| e.to_string())?;
    let marker = workspace.join("checkpoint.txt");
    let cancellation = Arc::new(AtomicBool::new(false));
    let monitor_cancel = cancellation.clone();
    let monitor_marker = marker.clone();
    let monitor = std::thread::spawn(move || {
        let start = Instant::now();
        while !monitor_marker.is_file() && start.elapsed() < Duration::from_secs(90) {
            std::thread::sleep(Duration::from_millis(100));
        }
        monitor_cancel.store(true, Ordering::SeqCst);
    });
    let interrupted = run_codex_design_turn(state, &profile, &api_key, model, &workspace,
        "resume-write-check", None,
        "This is an isolated write/recovery integration check. Immediately use a shell command to write exactly checkpoint-ready to checkpoint.txt in the current directory, then run a 60-second sleep in the same command. Do not inspect other files. The host intentionally cancels after the checkpoint exists.",
        Duration::from_secs(100), cancellation);
    monitor.join().map_err(|_| "checkpoint monitor failed")?;
    if !interrupted.as_ref().is_err_and(|e| e.contains("取消")) || !marker.is_file() {
        return Err(format!("未真实中断已写入的设计任务：{interrupted:?}"));
    }
    let thread_id: String = state.db.lock().query_row(
        "SELECT codex_thread_id FROM skill_design_sessions WHERE skill_id='resume-write-check'", [], |r| r.get(0)
    ).map_err(|e| format!("中断后线程未保留：{e}"))?;
    eprintln!("真实设计已写入并中断，开始续接写入检查");
    run_codex_design_turn(state, &profile, &api_key, model, &workspace, "resume-write-check", Some(&thread_id),
        "Continue the interrupted integration check. Read checkpoint.txt and verify its exact content is checkpoint-ready. Write exactly resumed-write-ok to resumed.txt in this directory. Execute the write; do not just explain. Stop immediately after verifying the saved file.",
        Duration::from_secs(90), Arc::new(AtomicBool::new(false)))?;
    if fs::read_to_string(workspace.join("resumed.txt")).unwrap_or_default().trim() != "resumed-write-ok" {
        return Err("续接设计未能真实写入新文件".into());
    }
    fs::write(workspace.join("repair.py"), "def run(:\n").map_err(|e|e.to_string())?;
    run_codex_design_turn(state, &profile, &api_key, model, &workspace, "resume-write-check", Some(&thread_id),
        "Repair the actual broken repair.py once. Replace it with valid Python that writes exactly repair-write-ok to repair-result.txt in the current directory when executed. Execute python3 repair.py and verify the saved output. Edit the actual file, do not just return code. Do not modify checkpoint.txt or resumed.txt.",
        Duration::from_secs(90), Arc::new(AtomicBool::new(false)))?;
    if fs::read_to_string(workspace.join("repair-result.txt")).unwrap_or_default().trim() != "repair-write-ok" {
        return Err("定向修复续接未能修改并执行实际脚本".into());
    }
    if fs::read_to_string(&marker).unwrap_or_default().trim() != "checkpoint-ready" {
        return Err("恢复过程改变了检查点".into());
    }
    Ok(json!({"success":true,"root":root,"threadId":thread_id,"checks":["真实模型首次写入","中断并保留线程","同一线程续接写入","同一线程修复脚本并执行","原检查点保持"]}))
}

fn legacy_staging_check(app: &AppHandle, state: &AppState, source: &Path, root: &Path, mode: &str) -> Result<(), String> {
    use std::net::TcpListener;
    eprintln!("本地协议与真实文件链路自检：legacy {mode}");
    let source_path = source.to_path_buf();
    let session = create_pipeline_session(state, &root.join("workspace"), std::slice::from_ref(&source_path))?;
    let input = list_session_attachments(state, &session.id)?;
    let source_hash = sha256_file(source)?;
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e|e.to_string())?;
    listener.set_nonblocking(true).map_err(|e|e.to_string())?;
    let address = listener.local_addr().map_err(|e|e.to_string())?;
    let profile_id = format!("self-check-compatible-{mode}");
    // An isolated loopback protocol fixture, not a user configuration and not
    // a real model/network check. No user credential is read or transmitted.
    state.db.lock().execute("INSERT INTO ai_profiles(id,provider,display_name,base_url,default_model) VALUES(?1,'openai_compatible','本地协议自检',?2,'self-check')",params![profile_id,format!("http://{address}")]).map_err(|e|e.to_string())?;
    let stop = AtomicBool::new(false);
    let cancellation = Arc::new(AtomicBool::new(false));
    let result = std::thread::scope(|scope| {
        let server = scope.spawn(|| -> Result<(), String> {
            let mut step = 0;
            let mut artifact_id = String::new();
            let mut structure = json!({});
            let deadline = Instant::now();
            while !stop.load(Ordering::SeqCst) && deadline.elapsed() < Duration::from_secs(90) {
                let (mut stream, _) = match listener.accept() {
                    Ok(value) => value,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => { std::thread::sleep(Duration::from_millis(10)); continue; }
                    Err(error) => return Err(error.to_string()),
                };
                stream.set_nonblocking(false).map_err(|e|e.to_string())?;
                stream.set_read_timeout(Some(Duration::from_secs(10))).map_err(|e|e.to_string())?;
                let mut reader = BufReader::new(stream.try_clone().map_err(|e|e.to_string())?);
                let mut length = 0;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).map_err(|e|e.to_string())?;
                    if line.trim().is_empty() { break; }
                    if let Some(value) = line.to_lowercase().strip_prefix("content-length:") { length = value.trim().parse::<usize>().map_err(|e|e.to_string())?; }
                }
                if length > 2_000_000 { return Err("模拟模型请求超出限制".into()); }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).map_err(|e|e.to_string())?;
                let body: Value = serde_json::from_slice(&body).map_err(|e|e.to_string())?;
                if !list_session_attachments(state, &session.id)?.iter().all(|a| a.kind != "artifact") { return Err("中间产物进入用户成果栏".into()); }
                let last = body["messages"].as_array().and_then(|v|v.last()).and_then(|v|v["content"].as_str()).unwrap_or("");
                if step == 1 {
                    let catalog: Value = serde_json::from_str(last.rsplit("附件：").next().unwrap_or("")).map_err(|e|format!("未收到暂存产物目录：{e}"))?;
                    artifact_id = catalog[0]["attachmentId"].as_str().ok_or("暂存成果ID缺失")?.into();
                } else if step == 2 {
                    structure = serde_json::from_str(last.strip_prefix("工具 read_word_structure 执行结果：").and_then(|s|s.split("\n暂存产物").next()).ok_or("未收到Word结构结果")?).map_err(|e|e.to_string())?;
                } else if step == 3 && mode == "success" {
                    let catalog: Value = serde_json::from_str(last.rsplit("附件：").next().unwrap_or("")).map_err(|e|e.to_string())?;
                    artifact_id = catalog[0]["attachmentId"].as_str().ok_or("编辑成果ID缺失")?.into();
                }
                if mode == "cancel" && step == 1 { cancellation.store(true, Ordering::SeqCst); }
                let action = match step {
                    0 => Some(("docx_to_gongwen", json!({"fileIds":[input[0].id]}))),
                    1 if mode != "cancel" => Some(("read_word_structure", json!({"id":artifact_id}))),
                    2 => Some(("edit_word", json!({"id":artifact_id,"sourceHash":if mode == "failure" {json!("stale")} else {structure["sourceHash"].clone()},"outputName":"最后填写成果.docx","edits":[{"locator":structure["blocks"][0]["locator"],"expected":structure["blocks"][0]["text"],"text":"兼容接口填写完成"}]}))),
                    3 if mode == "success" => Some(("deliver", json!({"attachmentIds":[artifact_id]}))),
                    _ => None,
                };
                let message = if let Some((tool, parameters)) = action {
                    json!({"content":Value::Null,"tool_calls":[{"id":format!("call-{step}"),"type":"function","function":{"name":"dispatch_tool","arguments":json!({"toolId":tool,"summary":"自检执行","parameters":parameters}).to_string()}}]})
                } else { json!({"content":"协议自检结束"}) };
                let response = json!({"model":"self-check","choices":[{"message":message}]}).to_string();
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).map_err(|e|e.to_string())?;
                step += 1;
            }
            Ok(())
        });
        let result = tauri::async_runtime::block_on(run_agent_turn(&SendAgentMessageRequest {session_id:session.id.clone(),content:"将Word公文排版后修改标题，只交付最后一份DOCX".into(),profile_id:profile_id.clone(),model:"self-check".into(),api_key:Some("isolated-not-a-real-key".into()),allow_model_file_access:true},app,state,&Events,"legacy-staging-check",cancellation.clone()));
        stop.store(true, Ordering::SeqCst);
        server.join().map_err(|_|"模拟模型线程失败")??;
        result
    });
    result?;
    let artifacts = list_session_attachments(state, &session.id)?.into_iter().filter(|a|a.kind == "artifact").collect::<Vec<_>>();
    if artifacts.len() != usize::from(mode == "success") || sha256_file(source)? != source_hash { return Err(format!("legacy {mode} 成果数量或原件核验失败")); }
    if mode == "success" {
        let path = PathBuf::from(artifacts[0].local_snapshot_path.as_deref().ok_or("最终成果路径缺失")?);
        let structure = run_word_request(&path,&json!({}),None,&root.join("verify"),&AtomicBool::new(false))?;
        if structure["blocks"][0]["text"] != "兼容接口填写完成" { return Err("legacy没有交付最后的填写成果".into()); }
    }
    Ok(())
}

#[cfg(windows)]
fn check_windows(app: &AppHandle, state: &AppState, root: &Path, first: &Path, second: &Path) -> Result<Value, String> {
    if python_sandbox::status().available || detect_codex_runtime_internal().available {
        return Err("Windows 预览版错误地启用了未适配的运行器".into());
    }
    let before = [sha256_file(first)?, sha256_file(second)?];
    for mode in ["success", "failure", "cancel"] {
        legacy_staging_check(app, state, first, &root.join(format!("compatible-{mode}")), mode)?;
    }
    check_pdf_merge_delivery(app, state, root)?;
    if before != [sha256_file(first)?, sha256_file(second)?] {
        return Err("自检原件发生变化".into());
    }

    // A synthetic, isolated credential verifies platform storage. No user
    // profiles, network APIs, or existing credentials are used.
    let entry = keyring::Entry::new("zhai.release-self-check", &Uuid::new_v4().to_string())
        .map_err(|error| error.to_string())?;
    let value = "isolated-not-a-real-key";
    entry.set_password(value).map_err(|error| error.to_string())?;
    let read = entry.get_password();
    entry.delete_credential().map_err(|error| error.to_string())?;
    if !matches!(read.as_deref(), Ok(actual) if actual == value)
        || !matches!(entry.get_password(), Err(keyring::Error::NoEntry))
    {
        return Err("Windows 凭据读回或移除失败".into());
    }

    Ok(json!({
        "success": true,
        "version": env!("CARGO_PKG_VERSION"),
        "platform": "windows",
        "checks": [
            "未启用 Codex 本地桥接或临时 Python 执行",
            "兼容接口本地协议驱动真实公文排版、Word 结构编辑和唯一成果交付",
            "模型失败和取消时不交付暂存成果",
            "三页 PDF 合并结果、顺序与原件哈希核验",
            "Windows 凭据写入、读回及删除"
        ]
    }))
}

pub(super) fn run(app: &AppHandle, root: &Path) -> Result<Value, String> {
    let state = AppState::open(root.join("data"))?;
    let input = root.join("empty");
    let fixtures = root.join("fixtures");
    fs::create_dir_all(&input).map_err(|e| e.to_string())?;
    fs::create_dir_all(&fixtures).map_err(|e| e.to_string())?;
    let script = root.join("fixtures.py");
fs::write(&script, "from docx import Document\ndef run(context, params):\n    outputs=[]\n    for i in range(2):\n        doc=Document()\n        doc.sections[0].header.paragraphs[0].text='联调样本'\n        doc.sections[0].footer.paragraphs[0].text='测试页脚'\n        doc.add_paragraph('测试通知' if i==0 else '第二批材料', style='Title')\n        doc.add_paragraph('各街道办事处：') if i==0 else None\n        doc.add_paragraph('请各单位于周五报送材料。').runs[0].bold=True\n        doc.add_paragraph('示范区财政局')\n        doc.add_paragraph('2026年9月16日')\n        path=context.output_dir / ('sample%d.docx'%i)\n        doc.save(path)\n        outputs.append(str(path))\n    return {'summary':'fixtures','outputs':outputs}\n").map_err(|e|e.to_string())?;
    let request = root.join("fixtures-request.json");
    write_json_atomic(
        &request,
        &json!({"schemaVersion":1,"neverOverwrite":true,"scriptPath":script,"inputDirectory":input,"outputDirectory":fixtures,"parameters":{}}),
    )?;
    let output = engine_command()?
        .arg("--run-agent-script")
        .arg(&request)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    let first = fixtures.join("sample0.docx");
    let second = fixtures.join("sample1.docx");
    #[cfg(windows)]
    return check_windows(app, &state, root, &first, &second);

    #[cfg(not(windows))]
    {
    if let Ok(url) = std::env::var("ZHAI_SELF_CHECK_HARNESS_URL") {
        return check_codex_loopback(app, &state, root, &first, &url);
    }
    let before = [sha256_file(&first)?, sha256_file(&second)?];
    let session = create_pipeline_session(
        &state,
        &root.join("workspace"),
        std::slice::from_ref(&first),
    )?;
    let attachments = list_session_attachments(&state, &session.id)?;
    let turn = "self-check-turn";
    let scratch = PathBuf::from(&session.workspace_path)
        .join("runs")
        .join(turn)
        .join("scratch");
    let delivery = root.join("delivery");
    fs::create_dir_all(&scratch).map_err(|e| e.to_string())?;
    let bridge = agent_tools::ToolSession::new(
        app,
        &state,
        &session,
        turn,
        &Events,
        Arc::new(AtomicBool::new(false)),
        &scratch,
        &delivery,
        &attachments,
    );
    let mut checks = Vec::new();
    mcp_bridge::with_server(
        agent_tools::definitions(),
        |name, args| bridge.dispatch(name, args),
        |endpoint| {
            let mut child = Command::new(std::env::current_exe().map_err(|e| e.to_string())?)
                .args(["--mcp-stdio", endpoint.path.to_str().ok_or("端点路径无效")?])
                .env("ZHAI_MCP_TOKEN", &endpoint.token)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| e.to_string())?;
            {
                let mut stdin = child.stdin.take().ok_or("代理缺少输入管道")?;
                writeln!(stdin,"{}",json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}})).map_err(|e|e.to_string())?;
                writeln!(stdin,"{}",json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_skills","arguments":{"query":"公文"}}})).map_err(|e|e.to_string())?;
                writeln!(stdin,"{}",json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_skill","arguments":{"id":"extract_pdf_text"}}})).map_err(|e|e.to_string())?;
            }
            let output = child.wait_with_output().map_err(|e| e.to_string())?;
            let replies = String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter_map(|s| serde_json::from_str::<Value>(s).ok())
                .collect::<Vec<_>>();
            if !output.status.success()
                || replies.len() != 3
                || replies[1]["result"]["isError"] != false
                || replies[2]["result"]["isError"] != false
                || replies[2]["result"]["structuredContent"]["formats"] != json!(["pdf"])
                || replies[2]["result"]["structuredContent"]["outputFormats"] != json!(["txt"])
            {
                return Err("真实 MCP 代理往返失败".into());
            }
            Ok(())
        },
    )?;
    checks.push("真实 stdio MCP 代理往返");
    checks.push("真实 MCP 能力契约区分 PDF 输入与 TXT 最终成果");
    let word_scratch = PathBuf::from(&session.workspace_path).join("runs/word-structure-check/scratch");
    let word_delivery = root.join("word-delivery");
    let word_bridge = agent_tools::ToolSession::new(app, &state, &session, "word-structure-check", &Events, Arc::new(AtomicBool::new(false)), &word_scratch, &word_delivery, &attachments);
    mcp_bridge::with_server(agent_tools::definitions(), |name, args| word_bridge.dispatch(name, args), |endpoint| {
        let mut child = Command::new(std::env::current_exe().map_err(|e| e.to_string())?)
            .args(["--mcp-stdio", endpoint.path.to_str().ok_or("端点路径无效")?])
            .env("ZHAI_MCP_TOKEN", &endpoint.token).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
        let mut stdin = child.stdin.take().ok_or("代理缺少输入管道")?;
        let mut stdout = BufReader::new(child.stdout.take().ok_or("代理缺少输出管道")?);
        let mut rpc = |id: usize, name: &str, arguments: Value| -> Result<Value, String> {
            writeln!(stdin,"{}",json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":name,"arguments":arguments}})).map_err(|e|e.to_string())?;
            stdin.flush().map_err(|e|e.to_string())?;
            let mut line = String::new();
            stdout.read_line(&mut line).map_err(|e|e.to_string())?;
            let reply: Value = serde_json::from_str(&line).map_err(|e|e.to_string())?;
            if reply["result"]["isError"] != false { return Err(format!("Word MCP 调用失败：{reply}")); }
            Ok(reply["result"]["structuredContent"].clone())
        };
        let structure = rpc(1, "read_word_structure", json!({"id":attachments[0].id}))?;
        let original = structure["blocks"][0]["text"].as_str().ok_or("结构缺少正文段落")?;
        let edited = rpc(2, "edit_word", json!({"id":attachments[0].id,"sourceHash":structure["sourceHash"],"outputName":"Word定位编辑验收.docx","edits":[{"locator":structure["blocks"][0]["locator"],"expected":original,"text":"Word定位编辑验收标题"}]}))?;
        if edited["outputs"].as_array().is_none_or(|v| v.len() != 1) { return Err("Word 定位编辑没有单一暂存DOCX".into()); }
        let attachment_count = list_session_attachments(&state, &session.id)?.len();
        let diagnostic = rpc(3,"run_python",json!({"diagnostic":true,"script":"def run(context):\n    path=context.output_dir / '检查.json'\n    path.write_text('{}')\n    return {'summary':'诊断不交付','outputs':[str(path)]}\n"}))?;
        if diagnostic["outputs"].as_array().is_none_or(|v|!v.is_empty()) || list_session_attachments(&state,&session.id)?.len() != attachment_count { return Err("MCP诊断标记没有阻止检查JSON成为成果".into()); }
        rpc(4, "deliver", json!({"input":"previous"}))?;
        drop(rpc);
        drop(stdin);
        if !child.wait().map_err(|e|e.to_string())?.success() { return Err("Word MCP 代理退出失败".into()); }
        Ok(())
    })?;
    let word_paths = fs::read_dir(&word_delivery).map_err(|e|e.to_string())?.map(|e|e.map(|v|v.path()).map_err(|e|e.to_string())).collect::<Result<Vec<_>, _>>()?;
    if word_paths.len() != 1 || sha256_file(&first)? != before[0] { return Err("Word定位编辑混入中间成果或改变原件".into()); }
    validate_generated_artifact(&word_paths[0])?;
    let verified = run_word_request(&word_paths[0], &json!({}), None, &word_scratch, &AtomicBool::new(false))?;
    if verified["blocks"][0]["text"] != "Word定位编辑验收标题" { return Err("Word定位编辑成果重开内容不正确".into()); }
    if workflow::promote(&state, &session.id, "word-structure-check", Some("不应直接重放")).is_ok() { return Err("固定定位/hash编辑不应直接沉淀能力".into()); }
    checks.push("真实 MCP Word 结构读取、定位编辑与最终交付");
    checks.push("Word 成果重开、原件哈希及定位流程沉淀拒绝");
    checks.push("真实 MCP 诊断标记阻止显式检查JSON输出成为成果");
    for mode in ["success", "failure", "cancel"] {
        legacy_staging_check(app, &state, &first, &root.join(format!("legacy-{mode}")), mode)?;
    }
    checks.push("兼容 Harness 真实文件暂存、结构编辑、最终选择及失败取消无成果（本地模拟模型协议）");
    let tools = bridge.dispatch("search_skills", json!({"query":"公文"}))?;
    if tools["skills"].as_array().is_none_or(|v| v.is_empty()) {
        return Err("能力检索没有返回公文排版".into());
    }
    checks.push("能力检索");
    let parameters = json!({"id":"docx_to_gongwen","parameters":{"addTitleBlankLine":true,"signatureMode":"unsigned"}});
    let one = bridge.dispatch("run_skill", parameters.clone())?;
    let repeated = bridge.dispatch("run_skill", parameters)?;
    if one != repeated {
        return Err("重复执行未被阻止".into());
    }
    checks.push("原生能力执行和重复调用防护");
    let two = bridge.dispatch("run_python",json!({"input":"previous","script":"from docx import Document\ndef run(context, params):\n    doc=Document(context.inputs[0])\n    assert doc.sections[0].footer.paragraphs[0].text=='测试页脚'\n    assert doc.paragraphs[-2].paragraph_format.space_before.pt==28\n    for p in doc.paragraphs:\n        if p.text=='各街道办事处：':\n            assert p.paragraph_format.first_line_indent.pt==0\n    doc.add_paragraph(params['suffix'])\n    path=context.output_dir / '核验后.docx'\n    doc.save(path)\n    return {'summary':'核验后处理完成','outputs':[str(path)]}\n","parameters":{"suffix":"核验完毕"}}))?;
    if two["step"] != 2 {
        return Err("多步执行记录不完整".into());
    }
    checks.push("隔离脚本与步骤参数");
    checks.push("打包引擎可选主送、落款空行与原页脚保留");
    bridge.dispatch("deliver", json!({}))?;
    if fs::read_dir(&delivery).map_err(|e| e.to_string())?.count() != 1 {
        return Err("中间成果混入交付目录".into());
    }
    checks.push("仅交付最终成果");
    let tool = workflow::promote(&state, &session.id, turn, Some("自检办公流程"))?;
    if tool.test_status.as_deref() != Some("untested") || tool.available {
        return Err("新工作流跳过了测试门槛".into());
    }
    checks.push("完整工作流保存为待测试草稿");
    let (_summary, outputs) = execute_skill_pipeline(
        app,
        &state,
        &tool,
        std::slice::from_ref(&second),
        &json!({}),
        Arc::new(AtomicBool::new(false)),
        &root.join("replay"),
        1,
        &mut HashSet::new(),
    )?;
    if outputs.len() != 1 {
        return Err("工作流复用未生成单一成果".into());
    }
    for path in &outputs {
        validate_generated_artifact(path)?;
    }
    let read_session = create_pipeline_session(&state, &root.join("verify"), &outputs)?;
    let (text, _) = execute_dynamic_python_scoped(
        &state,
        &read_session,
        "verify",
        "from docx import Document\ndef run(context, params):\n    text='\\n'.join(p.text for p in Document(context.inputs[0]).paragraphs)\n    return {'summary':text,'outputs':[]}\n",
        None,
        Arc::new(AtomicBool::new(false)),
        None,
        true,
        true,
    )?;
    if !text.contains("第二批材料") || !text.contains("核验完毕") || text.contains("测试通知")
    {
        return Err(format!("复用成果内容不符合预期：{text}"));
    }
    checks.push("更换材料复用及内容验收");
    let package = root.join("resource-package");
    fs::create_dir_all(package.join("assets")).map_err(|e| e.to_string())?;
    fs::create_dir_all(package.join("scripts")).map_err(|e| e.to_string())?;
    fs::write(package.join("assets/suffix.txt"), "模板已加载").map_err(|e| e.to_string())?;
    fs::write(
        package.join("scripts/helper.py"),
        "def decorate(text):\n    return text + '，辅助脚本已加载'\n",
    )
    .map_err(|e| e.to_string())?;
    let mut resource_tool = tool.clone();
    resource_tool.id = "resource-self-check".into();
    resource_tool.kind = Some("python".into());
    resource_tool.composition = None;
    resource_tool.package_path = Some(package.to_string_lossy().into_owned());
    resource_tool.parameters = vec![ToolParameter {
        key: "suffix".into(),
        label: "后缀".into(),
        parameter_type: "text".into(),
        required: true,
        default_value: Some(json!("默认参数已加载")),
        choices: None,
        placeholder: None,
    }];
    resource_tool.source_code = Some("from docx import Document\nfrom helper import decorate\ndef run(context, params):\n    text=decorate((context.resources_dir / 'assets/suffix.txt').read_text()) + params['suffix']\n    assert '模板已加载，辅助脚本已加载默认参数已加载' == text\n    doc=Document(context.inputs[0])\n    doc.add_paragraph(text)\n    path=context.output_dir / '资源验证.docx'\n    doc.save(path)\n    return {'summary':text,'outputs':[str(path)]}\n".into());
    let (_, resource_outputs) = execute_skill_pipeline(
        app,
        &state,
        &resource_tool,
        std::slice::from_ref(&second),
        &json!({}),
        Arc::new(AtomicBool::new(false)),
        &root.join("resource-replay"),
        1,
        &mut HashSet::new(),
    )?;
    if resource_outputs.len() != 1 {
        return Err("带模板的 Python 能力没有生成成果".into());
    }
    validate_generated_artifact(&resource_outputs[0])?;
    checks.push("Python 能力包模板、辅助脚本及默认参数");
    check_skill_lifecycle(app, &state, root, &resource_tool, &second)?;
    checks.extend([
        "必填参数样本测试、用例保留及重复样本去重",
        "未测试禁止发布，实际测试通过后发布运行",
        "无附件能力从测试到发布和生成Word",
    ]);
    let redhead = bridge.dispatch("run_skill", json!({"id":"apply_redhead","input":"original","parameters":{"unitName":"测试单位","officeName":"办公室"}}))?;
    if redhead["outputs"].as_array().is_none_or(|v| v.is_empty()) {
        return Err(format!("套红能力没有生成成果：{redhead}"));
    }
    let notice_path = scratch.join("user-notices.json");
    let notices = fs::read_to_string(&notice_path).map_err(|e| e.to_string())?;
    if !notices.contains("占位日期") {
        return Err("占位日期提示未传递至 Agent".into());
    }
    checks.push("原生套红能力与用户注意事项传递");
    if before != [sha256_file(&first)?, sha256_file(&second)?] {
        return Err("自检原件发生变化".into());
    }
    checks.push("原件哈希不变");
    check_pdf_merge_delivery(app, &state, root)?;
    checks.push("PDF合并只交付单个最终文件且三页顺序正确");
    #[cfg(target_os = "macos")]
    if let Some(font) = dirs::home_dir().map(|p| p.join("Library/Fonts/楷体_GB2312.ttf")).filter(|p| p.is_file()) {
        let outside = root.join("private-synthetic.txt");
        fs::write(&outside, "keep private").map_err(|e| e.to_string())?;
        execute_dynamic_python_scoped(&state, &session, "font-permission-check",
            "from pathlib import Path\nimport socket\ndef run(context, params):\n    assert len(Path(params['font']).open('rb').read(4))==4\n    for fn in [lambda:context.inputs[0].write_bytes(b'bad'),lambda:Path(params['outside']).read_bytes(),lambda:socket.create_connection(('127.0.0.1',9),timeout=1)]:\n        try: fn()\n        except PermissionError: pass\n        else: raise AssertionError('sandbox restriction lost')\n    return {'summary':'字体可读且输入/范围外/网络限制保持','outputs':[]}\n",
            Some(&json!({"font":font,"outside":outside})), Arc::new(AtomicBool::new(false)), None, false, true)?;
        checks.push("用户楷体可读且原件写入、范围外文件、网络仍阻断");
    }
    Ok(
        json!({"success":true,"version":env!("CARGO_PKG_VERSION"),"checks":checks,"outputs":outputs,"root":root}),
    )
    }
}

/// Explicit, isolated local protocol acceptance. This never reads a user's
/// profile or credentials and must not be reported as a cloud model check.
fn check_codex_loopback(app: &AppHandle, state: &AppState, root: &Path, source: &Path, url: &str) -> Result<Value, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| e.to_string())?;
    if parsed.scheme() != "http" || parsed.host_str() != Some("127.0.0.1")
        || parsed.port().is_none() || !parsed.username().is_empty() || parsed.password().is_some()
        || parsed.query().is_some() || parsed.fragment().is_some()
    {
        return Err("Harness 协议验收只允许显式本机 IPv4 HTTP 端点".into());
    }
    let id = "isolated-harness-protocol-check";
    state.db.lock().execute(
        "INSERT INTO ai_profiles(id,provider,display_name,base_url,default_model) VALUES(?1,'deepseek','本地模拟协议验收',?2,'deepseek-self-check')",
        params![id, url],
    ).map_err(|e| e.to_string())?;
    let session = create_pipeline_session(state, &root.join("harness-workspace"), &[source.to_path_buf()])?;
    let before = sha256_file(source)?;
    let mut thread_ids = Vec::new();
    for (turn, content) in [
        ("harness-first", "将本轮 Word 材料公文排版，只交付一份 DOCX。协议验收第一轮。"),
        ("harness-resume", "继续上一线程，仅查询 extract_pdf_text 能力的输入输出格式，不生成文件。协议验收第二轮。"),
    ] {
        run_codex_agent_turn(&SendAgentMessageRequest {
            session_id:session.id.clone(), content:content.into(), profile_id:id.into(),
            model:"deepseek-self-check".into(), api_key:Some("isolated-not-a-real-key".into()),
            allow_model_file_access:true,
        }, app, state, &Events, turn, Arc::new(AtomicBool::new(false)))?;
        thread_ids.push(codex_thread_id(state, &session.id).ok_or("CLI 未提供线程 ID")?);
    }
    if thread_ids[0] != thread_ids[1] { return Err("CLI 续接改变了原线程".into()); }
    let artifacts = list_session_attachments(state, &session.id)?.into_iter().filter(|a| a.kind == "artifact").collect::<Vec<_>>();
    if artifacts.len() != 1 || sha256_file(source)? != before {
        return Err("Harness 协议验收成果数量或原件哈希错误".into());
    }
    let result_path = PathBuf::from(artifacts[0].local_snapshot_path.as_deref().ok_or("成果缺少路径")?);
    validate_generated_artifact(&result_path)?;
    let reopened = run_word_request(&result_path, &json!({}), None, &root.join("harness-verify"), &AtomicBool::new(false))?;
    if !reopened.to_string().contains("请各单位于周五报送材料") {
        return Err("Harness 最终 Word 重开后正文缺失".into());
    }
    let runs = list_session_tool_runs(state, &session.id)?;
    if runs.iter().filter(|r| r.tool_id == "codex_harness" && r.status == "completed").count() != 2 {
        return Err("Harness 两轮未完整结束".into());
    }
    let mut cancellation_proof = Value::Null;
    if std::env::var("ZHAI_SELF_CHECK_HARNESS_CANCEL").as_deref() == Ok("1") {
        let marker = PathBuf::from(&session.workspace_path).join("cancel-pids.txt");
        let cancellation = Arc::new(AtomicBool::new(false));
        let stopped = AtomicBool::new(false);
        let observed_children = Mutex::new(Vec::<i32>::new());
        let start = Instant::now();
        let result = std::thread::scope(|scope| {
            scope.spawn(|| {
                while !stopped.load(Ordering::SeqCst) && start.elapsed() < Duration::from_secs(30) {
                    if marker.is_file() {
                        // Linux CLI sandbox PIDs are namespace-local. Record
                        // host PIDs from our application's live descendant tree
                        // before cancellation, never treat the marker's $$ as
                        // a host PID to inspect or signal.
                        if let Ok(output) = Command::new("ps").args(["-eo", "pid=,ppid=,comm="]).output() {
                            let table = String::from_utf8_lossy(&output.stdout).lines().filter_map(|line| {
                                let mut fields = line.split_whitespace();
                                Some((fields.next()?.parse::<i32>().ok()?, fields.next()?.parse::<i32>().ok()?, fields.next()?.to_string()))
                            }).collect::<Vec<_>>();
                            let mut owned = HashSet::from([std::process::id() as i32]);
                            loop {
                                let previous = owned.len();
                                for (pid, parent, _) in &table { if owned.contains(parent) { owned.insert(*pid); } }
                                if owned.len() == previous { break; }
                            }
                            *observed_children.lock() = table.into_iter().filter(|(pid, _, name)|
                                owned.contains(pid) && matches!(Path::new(name).file_name().and_then(|s|s.to_str()), Some("sleep" | "sh" | "bash" | "zsh")))
                                .map(|(pid, _, _)|pid).collect();
                        }
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(30));
                }
                cancellation.store(true, Ordering::SeqCst);
            });
            let result = run_codex_agent_turn(&SendAgentMessageRequest {
                session_id:session.id.clone(), content:"协议取消验收：运行测试子进程，等待外部取消，不生成成果。".into(),
                profile_id:id.into(), model:"deepseek-self-check".into(), api_key:Some("isolated-not-a-real-key".into()), allow_model_file_access:true,
            }, app, state, &Events, "harness-cancel", cancellation.clone());
            stopped.store(true, Ordering::SeqCst);
            result
        });
        result?;
        let namespace_pids = fs::read_to_string(&marker).map_err(|_| "真实 CLI shell 没有启动取消样本")?
            .split_whitespace().map(|s| s.parse::<i32>().map_err(|e|e.to_string())).collect::<Result<Vec<_>,_>>()?;
        let pids = observed_children.lock().clone();
        if namespace_pids.len() != 2 || pids.len() < 2 || pids.iter().any(|&pid| pid <= 1) { return Err("没有捕获真实 CLI shell 与 sleep 的宿主 PID".into()); }
        std::thread::sleep(Duration::from_millis(300));
        let mut survivors = Vec::new();
        for &pid in &pids {
            let status = Command::new("ps").args(["-o", "stat=", "-p", &pid.to_string()]).output().map_err(|e|e.to_string())?;
            let status = String::from_utf8_lossy(&status.stdout);
            if status.lines().any(|line| !line.trim().is_empty() && !line.trim().starts_with('Z')) { survivors.push(pid); }
        }
        cancellation_proof = json!({"hostPids":pids,"namespacePids":namespace_pids,"survivors":survivors,"seconds":start.elapsed().as_secs_f64()});
        write_json_atomic(&root.join("harness-cancellation-proof.json"), &cancellation_proof)?;
        if !survivors.is_empty() {
            // Reap only our explicitly recorded synthetic sleep test processes.
            #[cfg(unix)]
            for pid in survivors { unsafe { libc::kill(pid, libc::SIGKILL); } }
            return Err("取消后 CLI 测试子进程仍在运行，证据已保存".into());
        }
        let runs = list_session_tool_runs(state, &session.id)?;
        if !runs.iter().any(|r| r.tool_id == "codex_harness" && r.status == "cancelled") {
            return Err("CLI 取消没有记录为 cancelled".into());
        }
    }
    let proof = json!({"success":true,"version":env!("CARGO_PKG_VERSION"),"scope":"local-responses-fixture-not-cloud",
        "checks":["真实CLI→Unix MCP→AppState能力执行→DOCX最终交付", "同一CLI线程恢复并再次调用真实MCP", "成果重开正文验证及原件哈希不变"],
        "threadIds":thread_ids,"originalHash":before,"outputs":[result_path],"outputHash":sha256_file(&result_path)?,"cancellation":cancellation_proof,"root":root});
    write_json_atomic(&root.join("harness-proof.json"), &proof)?;
    Ok(proof)
}

fn check_pdf_merge_delivery(app: &AppHandle, state: &AppState, root: &Path) -> Result<(), String> {
    let session = create_pipeline_session(state, &root.join("pdf-fixtures"), &[])?;
    let (_, artifacts) = execute_dynamic_python_scoped(state, &session, "pdf-fixtures",
        "from pypdf import PdfWriter\ndef run(context, params):\n    out=[]\n    for name,width,count in [('b.pdf',200,2),('a.pdf',100,1)]:\n        writer=PdfWriter()\n        for _ in range(count): writer.add_blank_page(width=width,height=300)\n        p=context.output_dir/name\n        with p.open('wb') as f: writer.write(f)\n        out.append(str(p))\n    return {'summary':'PDF fixtures','outputs':out}\n",
        None, Arc::new(AtomicBool::new(false)), None, true, false)?;
    let inputs = artifact_paths(&artifacts);
    let before = inputs.iter().map(|p| sha256_file(p)).collect::<Result<Vec<_>,_>>()?;
    let tool = builtin_tools().into_iter().find(|t| t.id == "merge_pdf").ok_or("missing merge_pdf")?;
    let (_, outputs) = execute_skill_pipeline(app, state, &tool, &inputs, &json!({}), Arc::new(AtomicBool::new(false)), &root.join("pdf-merge"), 1, &mut HashSet::new())?;
    if outputs.len()!=1 { return Err(format!("PDF合并交付数量错误：{}", outputs.len())); }
    let verify = create_pipeline_session(state, &root.join("verify-pdf-merge"), &outputs)?;
    execute_dynamic_python_scoped(state, &verify, "verify",
        "from pypdf import PdfReader\ndef run(context, params):\n    assert len(context.inputs)==1\n    p=PdfReader(context.inputs[0])\n    assert [float(page.mediabox.width) for page in p.pages]==[100,200,200]\n    return {'summary':'PDF三页及顺序通过','outputs':[]}\n",
        None, Arc::new(AtomicBool::new(false)), None, false, true)?;
    if before != inputs.iter().map(|p| sha256_file(p)).collect::<Result<Vec<_>,_>>()? { return Err("PDF原件被修改".into()); }
    write_json_atomic(&root.join("pdf-merge-proof.json"), &json!({"outputs":outputs,"pages":3,"originalsUnchanged":true}))?;
    Ok(())
}

fn check_skill_lifecycle(
    app: &AppHandle,
    state: &AppState,
    root: &Path,
    prototype: &AgentTool,
    sample: &Path,
) -> Result<(), String> {
    let mut draft = prototype.clone();
    draft.id = "parameter-lifecycle-check".into();
    draft.name = "参数验收样本".into();
    draft.available = false;
    draft.status = Some("draft".into());
    draft.test_status = Some("untested".into());
    draft.parameters[0].default_value = None;
    draft.source_code = Some("from docx import Document\ndef run(context, params):\n    assert len(context.inputs)==1\n    assert context.inputs[0].name=='sample1.docx'\n    assert params['suffix']=='测试参数已传递'\n    d=Document(context.inputs[0])\n    d.add_paragraph(params['suffix'])\n    p=context.output_dir / '参数成果.docx'\n    d.save(p)\n    return {'summary':params['suffix'],'outputs':[str(p)]}\n".into());
    let draft = save_designed_tool_internal(draft, state)?;
    if publish_skill_inner(draft.id.clone(), state).is_ok() {
        return Err("未测试能力被发布".into());
    }
    let package = PathBuf::from(draft.package_path.as_deref().ok_or("没有能力包路径")?);
    write_json_atomic(
        &package.join("tests/cases.json"),
        &json!([{"name":"原有模型验收规则","inputs":[],"acceptance":["原件不变"]}]),
    )?;
    let mut request = TestSkillRequest {
        skill_id: draft.id.clone(),
        sample_paths: vec![sample.to_string_lossy().into()],
        parameters: json!({}),
    };
    if test_skill_inner(request.clone(), app, state).is_ok() {
        return Err("遗漏必填测试参数没有拒绝".into());
    }
    request.parameters = json!({"suffix":"测试参数已传递"});
    for _ in 0..2 {
        let tested = test_skill_inner(request.clone(), app, state)?;
        if tested.test_status.as_deref() != Some("passed") {
            return Err(format!("带参数样本失败：{}", tested.availability_detail));
        }
    }
    let cases: Vec<Value> = serde_json::from_slice(
        &fs::read(package.join("tests/cases.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if cases.len() != 2
        || cases[0]["name"] != "原有模型验收规则"
        || cases[1]["parameters"]["suffix"] != "测试参数已传递"
    {
        return Err("样本测试覆盖了原规则或没有记录实际参数".into());
    }
    let files = fs::read_dir(package.join("tests/fixtures"))
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_file())
        .count();
    if files != 1 {
        return Err("重复测试复制了重复样本".into());
    }
    let published = publish_skill_inner(draft.id.clone(), state)?;
    let result = run_skill_inner(
        RunSkillRequest {
            run_id: Uuid::new_v4().to_string(),
            skill_id: published.id,
            paths: vec![sample.to_string_lossy().into()],
            parameters: request.parameters,
        },
        app.clone(),
        state,
        &Events,
    )?;
    if result.artifacts.len() != 1 {
        return Err("带参数运行缺少成果".into());
    }
    let mut generator = draft;
    generator.id = "empty-input-generator-check".into();
    generator.name = "从零生成验收样本".into();
    generator.supported_extensions.clear();
    generator.parameters.clear();
    generator.source_code = Some("from docx import Document\ndef run(context, params):\n    assert context.inputs==[]\n    d=Document()\n    d.add_paragraph('从零生成内容验收')\n    p=context.output_dir / '从零生成.docx'\n    d.save(p)\n    return {'summary':'从零生成完成','outputs':[str(p)]}\n".into());
    let generator = save_designed_tool_internal(generator, state)?;
    let tested = test_skill_inner(
        TestSkillRequest {
            skill_id: generator.id.clone(),
            sample_paths: vec![],
            parameters: json!({}),
        },
        app,
        state,
    )?;
    if tested.test_status.as_deref() != Some("passed") {
        return Err(tested.availability_detail);
    }
    let generator = publish_skill_inner(generator.id, state)?;
    let result = run_skill_inner(
        RunSkillRequest {
            run_id: Uuid::new_v4().to_string(),
            skill_id: generator.id,
            paths: vec![],
            parameters: json!({}),
        },
        app.clone(),
        state,
        &Events,
    )?;
    let paths = artifact_paths(&result.artifacts);
    if paths.len() != 1 {
        return Err("无附件运行未交付一个文件".into());
    }
    let session = create_pipeline_session(state, &root.join("verify-generator"), &paths)?;
    execute_dynamic_python_scoped(
        state,
        &session,
        "verify",
        "from docx import Document\ndef run(context, params):\n    assert Document(context.inputs[0]).paragraphs[0].text=='从零生成内容验收'\n    return {'summary':'生成内容通过','outputs':[]}\n",
        None,
        Arc::new(AtomicBool::new(false)),
        None,
        false,
        true,
    )?;
    write_json_atomic(
        &root.join("skill-lifecycle.json"),
        &json!({"success":true,"generatorOutputs":result.artifacts,"cases":cases}),
    )?;
    Ok(())
}

pub(super) fn online(app: &AppHandle, root: &Path) -> Result<Value, String> {
    // Explicit test-only stdin input: never persist credentials or pass them in
    // argv. Normal application requests retain the existing Keychain flow.
    let session_key = if std::env::args().any(|a| a == "--self-check-key-stdin") {
        let mut value = String::new();
        std::io::stdin()
            .read_line(&mut value)
            .map_err(|e| e.to_string())?;
        let value = value.trim().to_owned();
        if value.is_empty() {
            return Err("联网自检缺少本次密钥".into());
        }
        Some(value)
    } else {
        None
    };
    let mut report = run(app, root)?;
    eprintln!("离线自检通过，开始真实 DeepSeek 聊天请求");
    let source = Connection::open_with_flags(
        app_data_directory(app)?.join("history.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| e.to_string())?;
    let (id, name, url, model): (String,String,String,String) = source.query_row(
        "SELECT id,display_name,base_url,default_model FROM ai_profiles WHERE provider='deepseek' AND key_stored=1 ORDER BY last_test_success DESC,id LIMIT 1", [],
        |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)),
    ).map_err(|_|"没有可供联网自检的已保存 DeepSeek 配置")?;
    drop(source);
    let state = AppState::open(root.join("online-data"))?;
    state.db.lock().execute("INSERT INTO ai_profiles(id,provider,display_name,base_url,default_model,key_stored) VALUES(?1,'deepseek',?2,?3,?4,1)",params![id,name,url,model]).map_err(|e|e.to_string())?;
    let session = create_pipeline_session(&state, &root.join("online-chat"), &[])?;
    let make_request = |session_id: String, content: &str, access: bool| SendAgentMessageRequest {
        session_id,
        content: content.into(),
        profile_id: id.clone(),
        model: model.clone(),
        api_key: session_key.clone(),
        allow_model_file_access: access,
    };
    tauri::async_runtime::block_on(send_agent_message_inner(
        make_request(
            session.id.clone(),
            "请记住：本次演示代号是海风。只回复已记住。",
            false,
        ),
        app.clone(),
        &state,
        &Events,
    ))?;
    let followup = tauri::async_runtime::block_on(send_agent_message_inner(
        make_request(
            session.id.clone(),
            "本次演示代号是什么？只回复代号。",
            false,
        ),
        app.clone(),
        &state,
        &Events,
    ))?;
    if !followup
        .messages
        .last()
        .is_some_and(|m| m.content.contains("海风"))
    {
        return Err("DeepSeek 连续聊天未记住上下文".into());
    }
    eprintln!("DeepSeek 连续聊天通过，开始真实 Codex 文件任务");
    let document_session = create_pipeline_session(
        &state,
        &root.join("online-document"),
        &[root.join("fixtures/sample0.docx")],
    )?;
    let result = tauri::async_runtime::block_on(send_agent_message_inner(
        make_request(
            document_session.id.clone(),
            "把这份通知按公文格式排版，保留原有加粗，并在标题后空一行。请只交付一个 DOCX。",
            true,
        ),
        app.clone(),
        &state,
        &Events,
    ))?;
    let artifacts = result
        .attachments
        .iter()
        .filter(|a| a.kind == "artifact")
        .collect::<Vec<_>>();
    if artifacts.len() != 1 {
        return Err("DeepSeek 文件任务没有交付单一成果".into());
    }
    if !result
        .tool_runs
        .iter()
        .any(|r| r.tool_id == "docx_to_gongwen" && r.status == "completed")
    {
        return Err("DeepSeek 未通过原生工具调用公文排版能力".into());
    }
    validate_generated_artifact(Path::new(
        artifacts[0]
            .local_snapshot_path
            .as_deref()
            .ok_or("成果路径缺失")?,
    ))?;
    eprintln!("真实 Codex + MCP 文件任务通过，验证工作流保存与换样本复用");
    let harness = result
        .tool_runs
        .iter()
        .find(|r| r.tool_id == "codex_harness" && r.status == "completed")
        .ok_or("未找到成功的 Codex 任务记录")?;
    let workflow = workflow::promote(
        &state,
        &document_session.id,
        &harness.turn_id,
        Some("联网验收排版流程"),
    )?;
    let (_, replay) = execute_skill_pipeline(
        app,
        &state,
        &workflow,
        &[root.join("fixtures/sample1.docx")],
        &json!({}),
        Arc::new(AtomicBool::new(false)),
        &root.join("online-replay"),
        1,
        &mut HashSet::new(),
    )?;
    let check = create_pipeline_session(&state, &root.join("online-replay-check"), &replay)?;
    let _guard = PipelineSessionGuard(&state, &check);
    execute_dynamic_python_scoped(
        &state,
        &check,
        "check",
        "from docx import Document\ndef run(context, params):\n    assert len(context.inputs)==1\n    d=Document(context.inputs[0])\n    texts=[p.text for p in d.paragraphs]\n    assert texts[0]=='第二批材料', texts\n    assert texts[1]=='', texts\n    assert any(r.bold for p in d.paragraphs if '报送材料' in p.text for r in p.runs)\n    return {'summary':'新样本标题、空行与加粗通过','outputs':[]}\n",
        None,
        Arc::new(AtomicBool::new(false)),
        None,
        true,
        true,
    )?;
    report["online"] = json!({"success":true,"model":model,"checks":["连续聊天上下文","DeepSeek + Codex + MCP 真实能力调用","单一 DOCX 成果验收","模型实际工作流保存与换样本复用"],"outputs":replay});
    write_json_atomic(&root.join("online-progress.json"), &report)?;
    eprintln!("工作流复用通过，开始同一会话追问修改");
    let revision = tauri::async_runtime::block_on(send_agent_message_inner(
        make_request(
            document_session.id.clone(),
            "在刚才的排版成果末尾追加一段“海风联调完成”，保留已有内容、加粗和标题后空行，只交付一个新的 DOCX。",
            true,
        ),
        app.clone(),
        &state,
        &Events,
    ))?;
    let previous_ids = artifacts
        .iter()
        .map(|a| a.id.as_str())
        .collect::<HashSet<_>>();
    let updated = revision
        .attachments
        .iter()
        .filter(|a| a.kind == "artifact" && !previous_ids.contains(a.id.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if updated.len() != 1 {
        return Err("追问修改未交付单一新成果".into());
    }
    let updated_paths = artifact_paths(&updated);
    let check_revision =
        create_pipeline_session(&state, &root.join("online-revision-check"), &updated_paths)?;
    let _revision_guard = PipelineSessionGuard(&state, &check_revision);
    execute_dynamic_python_scoped(
        &state,
        &check_revision,
        "check-revision",
        "from docx import Document\ndef run(context, params):\n    d=Document(context.inputs[0])\n    texts=[p.text for p in d.paragraphs]\n    assert texts[0]=='测试通知', texts\n    assert texts[1]=='', texts\n    assert texts[-1]=='海风联调完成', texts\n    assert any(r.bold for p in d.paragraphs if '报送材料' in p.text for r in p.runs)\n    return {'summary':'追问内容和格式通过','outputs':[]}\n",
        None,
        Arc::new(AtomicBool::new(false)),
        None,
        true,
        true,
    )?;
    report["online"]["checks"]
        .as_array_mut()
        .unwrap()
        .push(json!("同一会话追问修改与旧成果保留"));
    report["online"]["revisionOutputs"] = json!(updated_paths);
    write_json_atomic(&root.join("online-progress.json"), &report)?;
    eprintln!("追问修改通过，开始真实 Excel 字段对齐汇总");
    let fixture_session = create_pipeline_session(&state, &root.join("excel-fixtures"), &[])?;
    let _fixture_guard = PipelineSessionGuard(&state, &fixture_session);
    let (_, tables) = execute_dynamic_python_scoped(
        &state,
        &fixture_session,
        "excel-fixture",
        "from openpyxl import Workbook\ndef run(context, params):\n    outputs=[]\n    for name, rows in [('甲', [['单位','人数'],['甲单位',12]]), ('乙', [['人数','单位'],[8,'乙单位']])]:\n        w=Workbook()\n        for row in rows: w.active.append(row)\n        p=context.output_dir/(name+'.xlsx')\n        w.save(p)\n        outputs.append(str(p))\n    return {'summary':'合成报送表','outputs':outputs}\n",
        None,
        Arc::new(AtomicBool::new(false)),
        None,
        true,
        false,
    )?;
    let table_inputs = artifact_paths(&tables);
    let table_hashes = table_inputs
        .iter()
        .map(|p| sha256_file(p))
        .collect::<Result<Vec<_>, _>>()?;
    let excel_session = create_pipeline_session(&state, &root.join("online-excel"), &table_inputs)?;
    let excel = tauri::async_runtime::block_on(send_agent_message_inner(
        make_request(
            excel_session.id,
            "合并这两份报送表，按同名表头对齐，保留来源文件，只生成一份 XLSX。",
            true,
        ),
        app.clone(),
        &state,
        &Events,
    ))?;
    let excel_outputs = artifact_paths(
        &excel
            .attachments
            .iter()
            .filter(|a| a.kind == "artifact")
            .cloned()
            .collect::<Vec<_>>(),
    );
    if excel_outputs.len() != 1
        || !excel
            .tool_runs
            .iter()
            .any(|r| r.tool_id == "merge_xlsx" && r.status == "completed")
    {
        return Err("Excel 汇总未通过成熟能力生成单一成果".into());
    }
    let excel_check =
        create_pipeline_session(&state, &root.join("online-excel-check"), &excel_outputs)?;
    let _excel_guard = PipelineSessionGuard(&state, &excel_check);
    execute_dynamic_python_scoped(
        &state,
        &excel_check,
        "excel-check",
        "from openpyxl import load_workbook\ndef run(context, params):\n    w=load_workbook(context.inputs[0], data_only=True)\n    rows=list(w.active.values)\n    assert len(rows)==3, rows\n    header=list(rows[0]); unit=header.index('单位'); count=header.index('人数')\n    assert {r[unit]:r[count] for r in rows[1:]}=={'甲单位':12,'乙单位':8}, rows\n    assert any('来源' in str(h) for h in header), header\n    return {'summary':'字段对齐、数值和来源列通过','outputs':[]}\n",
        None,
        Arc::new(AtomicBool::new(false)),
        None,
        true,
        true,
    )?;
    if table_hashes
        != table_inputs
            .iter()
            .map(|p| sha256_file(p))
            .collect::<Result<Vec<_>, _>>()?
    {
        return Err("Excel 原件发生变化".into());
    }
    report["online"]["checks"]
        .as_array_mut()
        .unwrap()
        .push(json!("Excel 表头错位汇总、来源列与原件哈希"));
    report["online"]["excelOutputs"] = json!(excel_outputs);
    write_json_atomic(&root.join("online-progress.json"), &report)?;
    Ok(report)
}
