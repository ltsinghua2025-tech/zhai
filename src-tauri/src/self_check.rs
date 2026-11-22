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

fn copy_online_profile(app: &AppHandle, state: &AppState, stdin_key: bool) -> Result<(String, String), String> {
    let source = Connection::open_with_flags(
        app_data_directory(app)?.join("history.sqlite3"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ).map_err(|e| e.to_string())?;
    let selected = std::env::var("ZHAI_SELF_CHECK_PROFILE_ID").ok();
    let (id, provider, name, url, model): (String,String,String,String,String) = source.query_row(
        "SELECT id,provider,display_name,base_url,default_model FROM ai_profiles
         WHERE (key_stored=1 OR (?2 AND id=?1)) AND (id=?1 OR (?1 IS NULL AND provider='deepseek'))
         ORDER BY last_test_success DESC,id LIMIT 1", params![selected, stdin_key],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)),
    ).map_err(|_| "没有可供联网自检的模型配置")?;
    state.db.lock().execute(
        "INSERT INTO ai_profiles(id,provider,display_name,base_url,default_model,key_stored)
         VALUES(?1,?2,?3,?4,?5,1) ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,
         display_name=excluded.display_name,base_url=excluded.base_url,default_model=excluded.default_model,key_stored=1",
        params![id,provider,name,url,model],
    ).map_err(|e| e.to_string())?;
    Ok((id,model))
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
    let state = app.state::<AppState>();
    let (id, model) = copy_online_profile(app, &state, session_key.is_some())?;
    let provider = get_ai_profile(&state, &id)?.provider;
    if std::env::args().any(|a| a == "--self-check-design-resume") {
        return design_resume_check(&state, &id, &model, root, session_key.as_deref());
    }
    if std::env::args().any(|a| a == "--self-check-design-matrix") {
        let sample = root.join("首批.csv");
        let next = root.join("第二批.csv");
        fs::write(&sample, "value\n1\n2\n3\n4\n5\n6\n").map_err(|e| e.to_string())?;
        fs::write(&next, "value\n11\n12\n13\n14\n15\n").map_err(|e| e.to_string())?;
        let paths = vec![sample.display().to_string()];
        let spec = DesignToolRequest {
            design_id: Some("live-matrix".into()), current_skill_id: None,
            prompt: "创建离线 CSV 数字列转矩阵能力包。读取 CSV 表头 value 下的整数，保持顺序，每行放 cols 个数字（正整数，默认3），末行不足留空。用 openpyxl 写入名为 matrix 的工作表，每个输入对应一个 xlsx。不固定文件名或数值，原件只读。".into(),
            profile_id: id, model: model.clone(), api_key: session_key, kind: Some("python".into()),
            attachments: vec![DesignAttachment { path: paths[0].clone(), role: "sample_input".into() }],
        };
        let parameters = json!({"cols":3});
        let generated = tauri::async_runtime::block_on(design_and_test_skill_inner(DesignAndTestRequest {
            design: spec.clone(), run_id: "matrix-generation".into(), sample_paths: paths.clone(),
            parameters: parameters.clone(), auto_test: true,
        }, app, &state, &Events))?;
        let mut tool = generated.skill;
        let initial = generated.test_result.ok_or("生成后没有样本测试结果")?;
        if initial.status != "passed" { return Err(initial.summary); }
        // Only this synthetic package in the isolated self-check library is modified.
        let original = tool.source_code.as_deref().ok_or("生成包缺少源码")?;
        tool.source_code = Some(format!("{original}\n\ndef run(context, params=None):\n    raise RuntimeError('matrix acceptance injected failure')\n"));
        let broken = save_designed_tool_internal(tool, &state)?;
        let retest = |run_id: &str, sample_paths, repair| tauri::async_runtime::block_on(test_and_repair_skill_inner(TestAndRepairRequest {
            run_id: run_id.into(), design_id: Some("live-matrix".into()), skill_id: broken.id.clone(),
            sample_paths, parameters: parameters.clone(), repair,
        }, app, &state, &Events))?.test_result.ok_or_else(|| "没有正式测试结果".to_string());
        let repaired = retest("matrix-repair", paths, Some(spec))?;
        if repaired.status != "passed" || repaired.outputs.is_empty() { return Err(repaired.summary); }
        let reused = retest("matrix-reuse", vec![next.display().to_string()], None)?;
        if reused.status != "passed" { return Err(reused.summary); }
        return Ok(json!({"root":root,"model":model,"initial":initial,"repaired":repaired,"reuse":reused}));
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
        profile_id: id.clone(), model:model.clone(), api_key: session_key, kind: Some("python".into()),
        attachments: vec![DesignAttachment {path:first.to_string_lossy().into(),role:"sample_input".into()}],
    };
    // Re-run the exact package that exposed a runtime failure without asking
    // the model to generate a different implementation that happens to pass.
    let sample_paths=(1..=3).map(|i| first.join(format!("{i:02}.docx")).to_string_lossy().into()).collect();
    let tested = if let Some(package) = std::env::var_os("ZHAI_SELF_CHECK_DESIGNED_PACKAGE") {
        let tool=save_agent_tool(load_designed_package(&PathBuf::from(package))?,app.state())?;
        if publish_skill(tool.id.clone(),app.state()).is_ok(){return Err("未测试的草稿被发布".into());}
        tauri::async_runtime::block_on(test_and_repair_skill_inner(TestAndRepairRequest{run_id:"real-package-retest".into(),design_id:None,skill_id:tool.id,sample_paths,parameters:json!({}),repair:None},app,&state,&Events))?
    } else {
        tauri::async_runtime::block_on(design_and_test_skill_inner(DesignAndTestRequest{design:request,run_id:"real-design-and-test".into(),sample_paths,parameters:json!({}),auto_test:true},app,&state,&Events))?
    };
    if tested.skill.test_status.as_deref() != Some("passed") || tested.test_result.as_ref().is_none_or(|test|test.status!="passed") {
        return Err(format!("实际样本测试失败：{}", tested.skill.availability_detail));
    }
    let test_outputs=tested.test_result.as_ref().unwrap().outputs.clone();
    let tool=tested.skill;
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
        json!({"success":true,"root":root,"profileId":id,"provider":provider,"model":model,"skillId":published.id,"packagePath":published.package_path,"reusedPackage":std::env::var_os("ZHAI_SELF_CHECK_DESIGNED_PACKAGE").is_some(),"checks":["真实已配置模型生成能力包（复测时沿用同一包）","正式设计与样本测试链路（失败时有限修复）","测试成果保留","发布能力","首批三份与新文件夹两份独立复用","重新打开核对全文、顺序、表格、加粗与分页","原件哈希不变"],"testOutputs":test_outputs,"outputs":outputs}),
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
        Duration::from_secs(100), cancellation, None);
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
        Duration::from_secs(90), Arc::new(AtomicBool::new(false)), None)?;
    if fs::read_to_string(workspace.join("resumed.txt")).unwrap_or_default().trim() != "resumed-write-ok" {
        return Err("续接设计未能真实写入新文件".into());
    }
    fs::write(workspace.join("repair.py"), "def run(:\n").map_err(|e|e.to_string())?;
    run_codex_design_turn(state, &profile, &api_key, model, &workspace, "resume-write-check", Some(&thread_id),
        "Repair the actual broken repair.py once. Replace it with valid Python that writes exactly repair-write-ok to repair-result.txt in the current directory when executed. Execute python3 repair.py and verify the saved output. Edit the actual file, do not just return code. Do not modify checkpoint.txt or resumed.txt.",
        Duration::from_secs(90), Arc::new(AtomicBool::new(false)), None)?;
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
    #[derive(Default)]
    struct ReplyEvents(parking_lot::Mutex<String>);
    impl EventSink<AgentEvent> for ReplyEvents {
        fn send(&self, event: AgentEvent) -> Result<(), String> {
            if let AgentEvent::AssistantDelta { text, .. } = event {
                self.0.lock().push_str(&text);
            }
            Ok(())
        }
    }
    let events = ReplyEvents::default();
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
                let mut request_line = String::new();
                reader.read_line(&mut request_line).map_err(|e| e.to_string())?;
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
                if reject_unsupported_responses(&request_line, &mut stream)? { continue; }
                let body: Value = serde_json::from_slice(&body).map_err(|e|e.to_string())?;
                if !list_session_attachments(state, &session.id)?.iter().all(|a| a.kind != "artifact") { return Err("中间产物进入用户成果栏".into()); }
                let last = body["messages"].as_array().and_then(|v|v.last()).and_then(|v|v["content"].as_str()).unwrap_or("");
                if step == 1 {
                    let catalog: Value = serde_json::from_str(last.rsplit("附件：").next().unwrap_or(""))
                        .map_err(|e| format!("自检未收到暂存产物目录：{e}；合成工具回执：{}", last.chars().take(600).collect::<String>()))?;
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
                } else { json!({"content":"协议自检结束<｜end▁of▁sentence｜>"}) };
                let response = json!({"model":"self-check","choices":[{"message":message}]}).to_string();
                write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",response.len(),response).map_err(|e|e.to_string())?;
                step += 1;
            }
            Ok(())
        });
        let result = tauri::async_runtime::block_on(run_agent_turn(&SendAgentMessageRequest {attachment_ids:None,session_id:session.id.clone(),content:"将Word公文排版后修改标题，只交付最后一份DOCX".into(),profile_id:profile_id.clone(),model:"self-check".into(),api_key:Some("isolated-not-a-real-key".into()),allow_model_file_access:true},app,state,&events,"legacy-staging-check",cancellation.clone()));
        stop.store(true, Ordering::SeqCst);
        server.join().map_err(|_|"模拟模型线程失败")??;
        result
    });
    result?;
    let artifacts = list_session_attachments(state, &session.id)?.into_iter().filter(|a|a.kind == "artifact").collect::<Vec<_>>();
    if artifacts.len() != usize::from(mode == "success") || sha256_file(source)? != source_hash { return Err(format!("legacy {mode} 成果数量或原件核验失败")); }
    if mode == "success" {
        let saved: String = state.db.lock().query_row(
            "SELECT content FROM agent_messages WHERE session_id=?1 AND role='assistant'",
            params![session.id], |row| row.get(0)
        ).map_err(|e| e.to_string())?;
        if saved != "协议自检结束" || *events.0.lock() != saved {
            return Err("回复结束标记清理后，显示文字或数据库正文与预期不符".into());
        }
        let path = PathBuf::from(artifacts[0].local_snapshot_path.as_deref().ok_or("最终成果路径缺失")?);
        let structure = run_word_request(&path,&json!({}),None,&root.join("verify"),&AtomicBool::new(false))?;
        if structure["blocks"][0]["text"] != "兼容接口填写完成" { return Err("legacy没有交付最后的填写成果".into()); }
    }
    Ok(())
}

/// These fixtures implement only Chat Completions, as a real legacy gateway would.
fn reject_unsupported_responses(line: &str, stream: &mut std::net::TcpStream) -> Result<bool, String> {
    if line.split_whitespace().nth(1) != Some("/responses") { return Ok(false); }
    stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// Run the application against a bounded, local model-protocol fixture. The
/// implementation and resulting files still go through the production engine.
/// This is deliberately separate from real-model acceptance.
fn with_design_protocol<T>(
    state: &AppState,
    responses: Vec<Value>,
    action: impl FnOnce(&str) -> Result<T, String>,
) -> Result<(T, Vec<Value>), String> {
    use std::net::TcpListener;
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let address = listener.local_addr().map_err(|e| e.to_string())?;
    let profile_id = format!("design-protocol-{}", Uuid::new_v4());
    state.db.lock().execute(
        "INSERT INTO ai_profiles(id,provider,display_name,base_url,default_model) VALUES(?1,'openai_compatible','隔离设计协议验收',?2,'design-protocol')",
        params![profile_id, format!("http://{address}")],
    ).map_err(|e| e.to_string())?;
    let stop = AtomicBool::new(false);
    let requests = Mutex::new(Vec::new());
    std::thread::scope(|scope| {
        let server = scope.spawn(|| -> Result<(), String> {
            let deadline = Instant::now();
            while !stop.load(Ordering::SeqCst) && deadline.elapsed() < Duration::from_secs(90) {
                let (mut stream, _) = match listener.accept() {
                    Ok(value) => value,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(10));
                        continue;
                    }
                    Err(error) => return Err(error.to_string()),
                };
                stream.set_nonblocking(false).map_err(|e| e.to_string())?;
                stream.set_read_timeout(Some(Duration::from_secs(5))).map_err(|e| e.to_string())?;
                let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
                let mut request_line = String::new();
                reader.read_line(&mut request_line).map_err(|e| e.to_string())?;
                let mut length = 0;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).map_err(|e| e.to_string())?;
                    if line.trim().is_empty() { break; }
                    if let Some(value) = line.to_lowercase().strip_prefix("content-length:") {
                        length = value.trim().parse::<usize>().map_err(|e| e.to_string())?;
                    }
                }
                if length > 2_000_000 { return Err("设计协议请求超出自检限制".into()); }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).map_err(|e| e.to_string())?;
                if reject_unsupported_responses(&request_line, &mut stream)? { continue; }
                let body: Value = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
                let index = requests.lock().len();
                requests.lock().push(body);
                let Some(answer) = responses.get(index) else {
                    let response = "unexpected extra model request";
                    write!(stream, "HTTP/1.1 500 Internal Server Error\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response).map_err(|e| e.to_string())?;
                    return Err("设计循环超出预期模型调用次数".into());
                };
                let response = json!({"model":"design-protocol","choices":[{"message":{"role":"assistant","content":answer.to_string()}}]}).to_string();
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response).map_err(|e| e.to_string())?;
            }
            Ok(())
        });
        let result = action(&profile_id);
        stop.store(true, Ordering::SeqCst);
        server.join().map_err(|_| "设计协议验收线程失败")??;
        Ok((result?, requests.lock().clone()))
    })
}

fn matrix_design_response(source: &str) -> Value {
    json!({
        "name":"隔离验收—列数据转矩阵",
        "description":"将姓名列重排为两行三列；保留所有数据，原件只读。",
        "supportedExtensions":["xlsx"], "outputExtensions":["xlsx"],
        "parameters":[{"key":"cols","label":"矩阵列数","type":"number","required":true,"defaultValue":3,"choices":null,"placeholder":null}],
        "sourceCode":source,
        "acceptance":["所有姓名顺序保持","两行三列，末格为空","原件不变"]
    })
}

const BROKEN_MATRIX_SOURCE: &str = "def run(context, params):\n    destination = context.output_dir / '矩阵.xlsx'\n    raise RuntimeError('MATRIX_ACCEPTANCE_BROKEN')\n";
const FIXED_MATRIX_SOURCE: &str = r#"from openpyxl import Workbook, load_workbook
def run(context, params):
    book = load_workbook(context.inputs[0], data_only=False)
    values = [row[0] for row in book.active.iter_rows(min_row=2, values_only=True) if row[0] is not None]
    cols = int(params['cols'])
    if cols < 1:
        raise ValueError('矩阵列数必须大于0')
    out = Workbook()
    for index, value in enumerate(values):
        out.active.cell(index // cols + 1, index % cols + 1, value)
    path = context.output_dir / '矩阵验收成果.xlsx'
    out.save(path)
    book.close()
    return {'summary':'矩阵处理完成','outputs':[str(path)]}
"#;

fn design_loopback_request(profile_id: &str, design_id: &str, source: &Path) -> DesignToolRequest {
    // Deserialize the wire contract so optional fields retain the same defaults
    // used by the frontend rather than relying on test-only initialization.
    serde_json::from_value(json!({
        "designId":design_id,"currentSkillId":null,
        "prompt":"将Excel姓名列按每行3列重新排成矩阵，所有姓名顺序不变，原件不变。",
        "profileId":profile_id,"model":"design-protocol",
        "apiKey":"isolated-not-a-real-key","kind":"python",
        "attachments":[{"path":source,"role":"sample_input"}]
    })).expect("self-check design request")
}

fn check_design_lifecycle(app: &AppHandle, state: &AppState, root: &Path) -> Result<Vec<&'static str>, String> {
    eprintln!("0.28 设计链路：本地协议模型 + 正式隔离执行器（不是真实云端）");
    let root = root.join("design-lifecycle");
    let fixtures = root.join("fixtures");
    let empty = root.join("empty");
    fs::create_dir_all(&fixtures).map_err(|e| e.to_string())?;
    fs::create_dir_all(&empty).map_err(|e| e.to_string())?;
    let script = root.join("fixtures.py");
    fs::write(&script, r#"from openpyxl import Workbook
def run(context, params):
    paths = []
    for name, values in [('首批.xlsx', ['甲','乙','丙','丁','戊']), ('换样本.xlsx', ['一','二','三','四'])]:
        book = Workbook()
        book.active.append(['姓名'])
        for value in values:
            book.active.append([value])
        path = context.output_dir / name
        book.save(path)
        paths.append(str(path))
    return {'summary':'合成矩阵样本','outputs':paths}
"#).map_err(|e| e.to_string())?;
    let request_path = root.join("fixtures-request.json");
    write_json_atomic(&request_path, &json!({"schemaVersion":1,"neverOverwrite":true,"scriptPath":script,"inputDirectory":empty,"outputDirectory":fixtures,"parameters":{}}))?;
    let output = engine_command()?.arg("--run-agent-script").arg(&request_path).output().map_err(|e| e.to_string())?;
    if !output.status.success() { return Err(format!("设计验收样本生成失败：{}", String::from_utf8_lossy(&output.stderr))); }
    let first = fixtures.join("首批.xlsx");
    let second = fixtures.join("换样本.xlsx");
    let csv = fixtures.join("格式不匹配.csv");
    fs::write(&csv, "姓名\n甲\n乙\n").map_err(|e| e.to_string())?;
    let hashes = [sha256_file(&first)?, sha256_file(&second)?, sha256_file(&csv)?];
    let artifact_count = || -> Result<i64, String> {
        state.db.lock().query_row("SELECT count(*) FROM agent_attachments WHERE kind='artifact'", [], |r| r.get(0)).map_err(|e| e.to_string())
    };
    let before_artifacts = artifact_count()?;
    let (generated, requests) = with_design_protocol(state,
        vec![matrix_design_response(BROKEN_MATRIX_SOURCE), matrix_design_response(FIXED_MATRIX_SOURCE)],
        |profile_id| {
            let request: DesignAndTestRequest = serde_json::from_value(json!({
                "design":design_loopback_request(profile_id,"matrix-auto-check",&first),
                "samplePaths":[first],"parameters":{"cols":3},"runId":"matrix-auto-check","autoTest":true
            })).map_err(|e| e.to_string())?;
            tauri::async_runtime::block_on(design_and_test_skill_inner(request,app,state,&Events))
        })?;
    let tested = generated.test_result.as_ref().ok_or("自动设计没有返回测试结果")?;
    if generated.skill.test_status.as_deref() != Some("passed") || tested.status != "passed" || tested.outputs.len() != 1 {
        return Err(format!("失败实现自动修复后仍未通过正式测试：{}",tested.summary));
    }
    if requests.len()!=2 || !requests[1].to_string().contains("MATRIX_ACCEPTANCE_BROKEN") || !requests[1].to_string().contains("def run(context") {
        return Err("自动修复没有获得真实运行错误和原实现，或模型调用次数不正确".into());
    }
    let test_outputs = tested.outputs.iter().map(PathBuf::from).collect::<Vec<_>>();
    verify_matrix_output(state,&root.join("verify-first"),&test_outputs,&["甲","乙","丙","丁","戊"],3)?;
    if artifact_count()? != before_artifacts { return Err("能力包测试成果混入普通会话成果栏".into()); }
    let saved = resolve_skill(state,&generated.skill.id)?;
    if saved.test_status.as_deref()!=Some("passed") { return Err("自动测试通过后状态没有持久保存".into()); }
    check_design_state_persistence(state,&root,&first,&second,&generated)?;

    // A mismatched sample must be actionable input feedback, not a model call.
    let ((wrong_format, missing_parameter, cross_field), no_requests) = with_design_protocol(state,vec![],|profile_id| {
        let mut repair = design_loopback_request(profile_id,"persistent-matrix-a",&first);
        repair.current_skill_id = Some(saved.id.clone());
        let request: TestAndRepairRequest = serde_json::from_value(json!({
            "runId":"matrix-wrong-format","skillId":saved.id,"samplePaths":[csv],"parameters":{"cols":3},"repair":repair
        })).map_err(|e|e.to_string())?;
        let wrong = tauri::async_runtime::block_on(test_and_repair_skill_inner(request,app,state,&Events))?;
        let mut required = saved.clone();
        required.id = "matrix-required-input-check".into();
        required.status=Some("draft".into()); required.test_status=Some("untested".into()); required.available=false;
        required.parameters[0].default_value=None;
        let required=save_designed_tool_internal(required,state)?;
        repair.current_skill_id=Some(required.id.clone());
        repair.design_id=Some("matrix-required-input-design".into());
        let request: TestAndRepairRequest = serde_json::from_value(json!({
            "runId":"matrix-missing-parameter","skillId":required.id,"samplePaths":[first],"parameters":{},"repair":repair
        })).map_err(|e|e.to_string())?;
        let missing=tauri::async_runtime::block_on(test_and_repair_skill_inner(request,app,state,&Events))?;
        let mut ruled=required.clone();ruled.id="matrix-cross-field-check".into();
        ruled.parameters[0].default_value=Some(json!(0));
        let mut rows=ruled.parameters[0].clone();rows.key="rows".into();rows.label="行数".into();ruled.parameters.push(rows);
        let ruled=save_designed_tool_internal(ruled,state)?;
        let rules=PathBuf::from(ruled.package_path.as_deref().ok_or("参数规则测试包缺失")?).join("references/parameter-rules.json");
        fs::create_dir_all(rules.parent().unwrap()).map_err(|e|e.to_string())?;
        write_json_atomic(&rules,&json!({"atLeastOnePositive":[["rows","cols"]]}))?;
        repair.current_skill_id=Some(ruled.id.clone());
        repair.design_id=Some("matrix-cross-field-design".into());
        let request:TestAndRepairRequest=serde_json::from_value(json!({"runId":"matrix-cross-field-run","skillId":ruled.id,"samplePaths":[first],"parameters":{},"repair":repair})).map_err(|e|e.to_string())?;
        let cross_field=tauri::async_runtime::block_on(test_and_repair_skill_inner(request,app,state,&Events))?;
        if !cross_field.test_result.as_ref().is_some_and(|test|test.summary.contains("至少填写")){return Err("行数列数交叉规则未在执行前给出补充输入提示".into());}
        Ok((wrong,missing,cross_field))
    })?;
    for result in [&wrong_format,&missing_parameter,&cross_field] {
        let test=result.test_result.as_ref().ok_or("预检未返回可见测试结果")?;
        if test.status=="passed" || test.repairable || !test.outputs.is_empty() { return Err("格式/参数预检错误被误标成功或触发代码修复".into()); }
        if publish_skill_inner(result.skill.id.clone(),state).is_ok() { return Err("预检未通过的能力仍被允许发布".into()); }
    }
    if !no_requests.is_empty() { return Err("输入预检错误消耗了模型修复调用".into()); }
    let persisted: String=state.db.lock().query_row("SELECT state_json FROM skill_design_state WHERE design_id='persistent-matrix-a'",[],|row|row.get(0)).map_err(|e|e.to_string())?;
    let persisted:SkillDesignState=serde_json::from_str(&persisted).map_err(|e|e.to_string())?;
    if persisted.test_result.as_ref().is_none_or(|r|r.status!="needs_input") || persisted.messages.len()!=2 || persisted.skill_id.as_deref()!=Some(saved.id.as_str()) {return Err("预检失败状态或原设计记录未保留".into());}
    let sibling:String=state.db.lock().query_row("SELECT state_json FROM skill_design_state WHERE design_id='persistent-matrix-c'",[],|row|row.get(0)).map_err(|e|e.to_string())?;
    let sibling:SkillDesignState=serde_json::from_str(&sibling).map_err(|e|e.to_string())?;
    if sibling.parameters!=json!({"cols":7}) || sibling.messages[0].content!="设计C独立规则" || sibling.test_result.is_some(){return Err("同包的不同设计会话串用了测试参数/消息/成果".into());}

    // Re-test after an input error, publish, and execute against unseen input.
    let request:TestAndRepairRequest=serde_json::from_value(json!({
        "runId":"matrix-retest","designId":"persistent-matrix-a","skillId":saved.id,"samplePaths":[first],"parameters":{"cols":3},"repair":null
    })).map_err(|e|e.to_string())?;
    let retested=tauri::async_runtime::block_on(test_and_repair_skill_inner(request,app,state,&Events))?;
    if retested.skill.test_status.as_deref()!=Some("passed") { return Err("修正输入后不能重测通过".into()); }
    let published=publish_skill_inner(saved.id.clone(),state)?;
    let (_,reused)=execute_skill_pipeline(app,state,&published,std::slice::from_ref(&second),&json!({"cols":2}),Arc::new(AtomicBool::new(false)),&root.join("offline-reuse"),1,&mut HashSet::new())?;
    verify_matrix_output(state,&root.join("verify-reuse"),&reused,&["一","二","三","四"],2)?;
    check_design_cancel(app,state,&root,&saved,&first)?;
    check_design_failure_bounds(app,state,&root,&saved,&first)?;
    if hashes != [sha256_file(&first)?,sha256_file(&second)?,sha256_file(&csv)?] { return Err("设计测试或复用修改了原件".into()); }
    write_json_atomic(&root.join("proof.json"),&json!({"kind":"local-protocol-real-executor","skillId":saved.id,"modelRequests":requests.len(),"preflightModelRequests":no_requests.len(),"testOutputs":test_outputs,"reuseOutputs":reused,"originalHashes":hashes,"originalsUnchanged":true,"testArtifactsExcluded":true}))?;
    Ok(vec!["设计生成、正式样本失败、真实错误回馈、有限自动修复与重测通过（本地协议）","独立设计会话、样本角色、消息、参数和测试成果重开恢复","测试成果独立保留并重开验证矩阵内容与顺序","格式/必填参数预检不调用模型且未通过禁止发布","修正输入重测后发布，换样本离线复用及原件哈希不变","样本执行取消有界退出、不调用修复、不保留半套成果","自动修复一次仍失败时停止，损坏成果与联网自建能力不通过"])
}

fn check_design_failure_bounds(app:&AppHandle,state:&AppState,root:&Path,prototype:&AgentTool,sample:&Path)->Result<(),String>{
    let mut network_response=matrix_design_response(FIXED_MATRIX_SOURCE);
    network_response["requiresNetwork"]=json!(true);network_response["permissions"]=json!(["read_inputs","write_outputs","network"]);
    let (network_design,network_requests)=with_design_protocol(state,vec![network_response],|profile_id|{
        let request:DesignAndTestRequest=serde_json::from_value(json!({"design":design_loopback_request(profile_id,"network-declared-check",sample),"samplePaths":[sample],"parameters":{"cols":3},"runId":"network-declared-run","autoTest":true})).map_err(|e|e.to_string())?;
        tauri::async_runtime::block_on(design_and_test_skill_inner(request,app,state,&Events))
    })?;
    if network_requests.len()!=1 || !network_design.skill.requires_network || network_design.test_result.as_ref().is_none_or(|r|r.status!="needs_input" || r.repairable || !r.outputs.is_empty()) || publish_skill_inner(network_design.skill.id,state).is_ok(){return Err("设计协议丢失联网声明或错误执行/修复/发布联网能力".into());}
    let (failed,requests)=with_design_protocol(state,vec![matrix_design_response(BROKEN_MATRIX_SOURCE),matrix_design_response(BROKEN_MATRIX_SOURCE)],|profile_id|{
        let request:DesignAndTestRequest=serde_json::from_value(json!({"design":design_loopback_request(profile_id,"matrix-bound-check",sample),"samplePaths":[sample],"parameters":{"cols":3},"runId":"matrix-bound-run","autoTest":true})).map_err(|e|e.to_string())?;
        tauri::async_runtime::block_on(design_and_test_skill_inner(request,app,state,&Events))
    })?;
    let test=failed.test_result.as_ref().ok_or("失败设计没有测试记录")?;
    if requests.len()!=2 || test.status!="failed" || !test.outputs.is_empty() || publish_skill_inner(failed.skill.id.clone(),state).is_ok(){return Err("自动修复超出一次、伪报通过或允许失败发布".into());}
    for (id,network,source) in [
        ("matrix-corrupt-check",false,"def run(context, params):\n    p=context.output_dir / '损坏.xlsx'\n    p.write_text('not a workbook')\n    return {'summary':'声称成功但文件损坏','outputs':[str(p)]}\n"),
        ("matrix-network-check",true,FIXED_MATRIX_SOURCE),
    ]{
        let mut draft=prototype.clone(); draft.id=id.into();draft.status=Some("draft".into());draft.test_status=Some("untested".into());draft.available=false;
        draft.requires_network=network;draft.permissions.retain(|p|p!="network");if network{draft.permissions.push("network".into());}
        draft.source_code=Some(source.into());let draft=save_designed_tool_internal(draft,state)?;
        let request:TestAndRepairRequest=serde_json::from_value(json!({"runId":format!("{id}-run"),"skillId":draft.id,"samplePaths":[sample],"parameters":{"cols":3},"repair":null})).map_err(|e|e.to_string())?;
        let result=tauri::async_runtime::block_on(test_and_repair_skill_inner(request,app,state,&Events))?;
        let test=result.test_result.as_ref().ok_or("负向测试结果缺失")?;
        if test.status=="passed" || !test.outputs.is_empty() || publish_skill_inner(result.skill.id.clone(),state).is_ok(){return Err(format!("{id} 未拒绝错误测试或发布"));}
        if network && (!result.skill.requires_network || !result.skill.permissions.iter().any(|p|p=="network") || test.repairable){return Err("联网声明丢失或被当作脚本错误修复".into());}
    }
    // Synthetic trace metadata checks recursive runtime dependency declarations;
    // this does not claim that an external service was actually executed.
    let child=resolve_skill(state,"matrix-network-check")?;
    let mut wrapper=prototype.clone();wrapper.id="nested-network-check".into();wrapper.kind=Some("workflow".into());wrapper.source_code=None;wrapper.steps.clear();
    wrapper.requires_network=false;wrapper.permissions.retain(|p|p!="network");
    wrapper.composition=Some(SkillComposition{schema_version:2,version_policy:"locked".into(),stages:vec![SkillStage::Skill{skill_id:child.id,input:"original".into(),parameters:json!({"cols":3})}]});
    let mut wrapper=save_designed_tool_internal(wrapper,state)?;
    if !wrapper.requires_network {return Err("工作流保存丢失子能力联网依赖".into());}
    wrapper.requires_network=false;wrapper.permissions.retain(|p|p!="network");
    let session=create_pipeline_session(state,&root.join("network-trace"),&[sample.to_path_buf()])?;
    insert_agent_message(state,&session.id,"user","网络依赖元数据合成验收",Some("network-metadata-check"))?;
    let staged=root.join("network-trace-staged.xlsx");
    fs::copy(sample,&staged).map_err(|e|format!("准备网络元数据验收成果副本失败：{e}"))?;
    publish_agent_artifacts(state,&session,"合成验收成果",&[staged])?;
    insert_agent_message(state,&session.id,"assistant","合成记录用于依赖标记测试，不代表已执行外部服务",Some("network-metadata-check"))?;
    let input_ids=list_session_attachments(state,&session.id)?.into_iter().filter(|a|a.kind!="artifact").map(|a|a.id).collect::<Vec<_>>();
    let trace=PathBuf::from(&session.workspace_path).join("runs/network-metadata-check/scratch/workflow-trace.json");
    fs::create_dir_all(trace.parent().unwrap()).map_err(|e|e.to_string())?;
    write_json_atomic(&trace,&json!({"steps":[{"tool":wrapper,"input":"original","parameters":{}}],"delivery":"previous","inputIds":input_ids}))?;
    let promoted=workflow::promote(state,&session.id,"network-metadata-check",Some("联网依赖元数据验收"))?;
    if !promoted.requires_network || !promoted.permissions.iter().any(|p|p=="network") || promoted.available {return Err("沉淀链路未递归保留联网运行依赖".into());}
    // Simulate an old manifest that incorrectly declared a dependent workflow
    // offline. Reading the catalog must correct the display without rewriting it.
    let legacy_root=skill_package_path(state,"nested-network-check")?;
    let legacy_manifest=legacy_root.join("skill.json");
    let mut raw:Value=serde_json::from_slice(&fs::read(&legacy_manifest).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    raw["requiresNetwork"]=json!(false);raw["permissions"]=json!(["read_inputs","write_outputs"]);raw["status"]=json!("published");raw["testStatus"]=json!("passed");raw["available"]=json!(true);
    write_json_atomic(&legacy_manifest,&raw)?;
    let legacy_before=hash_skill_package(&legacy_root)?;
    if resolve_skill(state,"nested-network-check")?.requires_network {return Err("旧包验收前置条件未保留磁盘显式离线声明".into());}
    let listed=loaded_skill_catalog(state)?.into_iter().find(|tool|tool.id=="nested-network-check").ok_or("旧联网依赖包未列出")?;
    let opened=loaded_skill_catalog(state)?.into_iter().find(|tool|tool.id=="nested-network-check").ok_or("旧联网依赖包无法重读")?;
    if !listed.requires_network || listed.available || !opened.requires_network || opened.available {return Err("旧包显式离线声明掩盖了实际联网依赖".into());}
    if legacy_before!=hash_skill_package(&legacy_root)? {return Err("读取旧包时写入了能力包文件".into());}
    write_json_atomic(&root.join("failure-bounds.json"),&json!({"modelRequests":requests.len(),"status":test.status,"unpublished":true,"corruptOutputRejected":true,"networkDependencyRetainedAndBlocked":true,"legacyNetworkCatalogReadOnly":true}))?;
    Ok(())
}

fn check_design_state_persistence(state:&AppState,root:&Path,first:&Path,second:&Path,result:&SkillDesignRunResult)->Result<(),String>{
    let a=create_pipeline_session(state,&root.join("design-session-a"),&[first.to_path_buf()])?;
    let b=create_pipeline_session(state,&root.join("design-session-b"),&[second.to_path_buf()])?;
    let c=create_pipeline_session(state,&root.join("design-session-c"),&[second.to_path_buf()])?;
    let first_attachment=list_session_attachments(state,&a.id)?.into_iter().next().ok_or("设计会话A没有样本")?;
    let second_attachment=list_session_attachments(state,&b.id)?.into_iter().next().ok_or("设计会话B没有样本")?;
    let first_state:SkillDesignState=serde_json::from_value(json!({"designId":"persistent-matrix-a","skillId":result.skill.id,"messages":[{"role":"user","content":"设计A的规则"},{"role":"assistant","content":"设计A的反馈"}],"attachmentRoles":{first_attachment.id.clone():"sample_input"},"parameters":{"cols":3},"testResult":result.test_result})).map_err(|e|e.to_string())?;
    let second_state:SkillDesignState=serde_json::from_value(json!({"designId":"persistent-matrix-b","skillId":null,"messages":[],"attachmentRoles":{second_attachment.id.clone():"reference"},"parameters":{"cols":2},"testResult":null})).map_err(|e|e.to_string())?;
    save_design_state_inner(state,&a.id,first_state.clone())?;
    save_design_state_inner(state,&b.id,second_state.clone())?;
    let sibling:SkillDesignState=serde_json::from_value(json!({"designId":"persistent-matrix-c","skillId":result.skill.id,"messages":[{"role":"user","content":"设计C独立规则"}],"attachmentRoles":{},"parameters":{"cols":7},"testResult":null})).map_err(|e|e.to_string())?;
    save_design_state_inner(state,&c.id,sibling.clone())?;
    let reopened=AppState::open(state.data_dir.clone())?;
    let restored_a=get_design_state_inner(&reopened,&a.id)?.ok_or("设计A无法重开")?;
    let restored_b=get_design_state_inner(&reopened,&b.id)?.ok_or("设计B无法重开")?;
    if serde_json::to_value(get_design_state_inner(&reopened,&c.id)?).map_err(|e|e.to_string())? != serde_json::to_value(Some(sibling)).map_err(|e|e.to_string())? {return Err("同包独立设计C无法重开".into());}
    if serde_json::to_value(&restored_a).map_err(|e|e.to_string())? != serde_json::to_value(&first_state).map_err(|e|e.to_string())? || serde_json::to_value(&restored_b).map_err(|e|e.to_string())? != serde_json::to_value(&second_state).map_err(|e|e.to_string())? {
        return Err("独立设计会话的草稿、消息、参数、样本角色或测试结果串用/丢失".into());
    }
    let mut invalid=first_state;
    invalid.design_id="../outside".into();
    if save_design_state_inner(state,&a.id,invalid).is_ok(){return Err("设计ID路径越界未拒绝".into());}
    Ok(())
}

struct CancelSampleEvents<'a> {
    state:&'a AppState,
    run_id:&'a str,
    monitor:Mutex<Option<std::thread::JoinHandle<()>>>,
}
impl EventSink<SkillDesignEvent> for CancelSampleEvents<'_> {
    fn send(&self,event:SkillDesignEvent)->Result<(),String>{
        if matches!(&event,SkillDesignEvent::Phase{phase,..} if phase=="testing") && self.monitor.lock().is_none() {
            let flag=self.state.skill_design_cancellations.lock().get(self.run_id).cloned().ok_or("测试取消句柄缺失")?;
            *self.monitor.lock()=Some(std::thread::spawn(move||{std::thread::sleep(Duration::from_millis(750));flag.store(true,Ordering::SeqCst);}));
        }
        Ok(())
    }
}
fn check_design_cancel(app:&AppHandle,state:&AppState,root:&Path,prototype:&AgentTool,sample:&Path)->Result<(),String>{
    let mut slow=prototype.clone();
    slow.id="matrix-cancel-check".into(); slow.status=Some("draft".into());slow.test_status=Some("untested".into());slow.available=false;
    slow.source_code=Some("import time\ndef run(context, params):\n    destination=context.output_dir / '不应交付.xlsx'\n    time.sleep(30)\n    raise RuntimeError('取消后不应继续运行')\n".into());
    let slow=save_designed_tool_internal(slow,state)?;
    let run_id="matrix-cancel-run";
    let events=CancelSampleEvents{state,run_id,monitor:Mutex::new(None)};
    let started=Instant::now();
    let (cancelled,requests)=with_design_protocol(state,vec![],|profile_id|{
        let mut repair=design_loopback_request(profile_id,"matrix-cancel-design",sample);
        repair.current_skill_id=Some(slow.id.clone());
        let request:TestAndRepairRequest=serde_json::from_value(json!({"runId":run_id,"skillId":slow.id,"samplePaths":[sample],"parameters":{"cols":3},"repair":repair})).map_err(|e|e.to_string())?;
        tauri::async_runtime::block_on(test_and_repair_skill_inner(request,app,state,&events))
    })?;
    if let Some(monitor)=events.monitor.lock().take(){monitor.join().map_err(|_|"取消验收监控失败")?;}
    let test=cancelled.test_result.as_ref().ok_or("取消测试缺少状态")?;
    if started.elapsed()>Duration::from_secs(12) || test.status!="cancelled" || !test.outputs.is_empty() || test.repairable || !requests.is_empty() {
        return Err(format!("样本取消没有有界停止或错误修复/交付：{}",test.summary));
    }
    if state.skill_design_cancellations.lock().contains_key(run_id) {return Err("取消后运行锁未清理".into());}
    if publish_skill_inner(slow.id,state).is_ok(){return Err("已取消的测试仍被允许发布".into());}
    write_json_atomic(&root.join("cancel-proof.json"),&json!({"status":test.status,"elapsedMs":started.elapsed().as_millis(),"repairModelRequests":requests.len(),"outputs":test.outputs}))?;
    Ok(())
}

fn verify_matrix_output(state:&AppState,root:&Path,outputs:&[PathBuf],expected:&[&str],cols:usize)->Result<(),String>{
    if outputs.len()!=1 || outputs[0].extension().and_then(|s|s.to_str())!=Some("xlsx") { return Err("矩阵测试必须只生成一个 XLSX".into()); }
    validate_generated_artifact(&outputs[0])?;
    let session=create_pipeline_session(state,root,outputs)?;
    execute_dynamic_python_scoped(state,&session,"verify",
        "from openpyxl import load_workbook\nimport math\ndef run(context, params):\n    book=load_workbook(context.inputs[0],data_only=False)\n    sheet=book.active\n    expected=params['expected']\n    cols=params['cols']\n    assert sheet.max_row==math.ceil(len(expected)/cols), '矩阵行数错误'\n    assert sheet.max_column==cols, '矩阵列数错误'\n    values=[v for row in sheet.iter_rows(values_only=True) for v in row]\n    assert values[:len(expected)]==expected, ('值或顺序错误',values)\n    assert all(v is None for v in values[len(expected):]), '末尾填充错误'\n    book.close()\n    return {'summary':'矩阵尺寸、数值、顺序、补空检查通过','outputs':[]}\n",
        Some(&json!({"expected":expected,"cols":cols})),Arc::new(AtomicBool::new(false)),None,false,true)?;
    Ok(())
}

#[cfg(windows)]
fn windows_manual_outputs(app: &AppHandle, state: &AppState, skill: &str, inputs: &[PathBuf], parameters: Value, expected: usize) -> Result<Vec<PathBuf>, String> {
    let hashes = inputs.iter().map(|p| sha256_file(p)).collect::<Result<Vec<_>, _>>()?;
    let result = run_skill_inner(RunSkillRequest {
        run_id: Uuid::new_v4().to_string(), skill_id: skill.into(),
        paths: inputs.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
        parameters,
    }, app.clone(), state, &Events).map_err(|e| format!("{skill}：{e}"))?;
    if hashes != inputs.iter().map(|p| sha256_file(p)).collect::<Result<Vec<_>, _>>()? {
        return Err(format!("{skill} 修改了原件"));
    }
    let outputs = artifact_paths(&result.artifacts);
    if outputs.len() != expected { return Err(format!("{skill} 应交付 {expected} 份成果，实际生成 {} 份", outputs.len())); }
    Ok(outputs)
}

#[cfg(windows)]
fn windows_manual_output(app: &AppHandle, state: &AppState, skill: &str, inputs: &[PathBuf]) -> Result<PathBuf, String> {
    let mut outputs = windows_manual_outputs(app, state, skill, inputs, json!({}), 1)?;
    Ok(outputs.remove(0))
}

#[cfg(windows)]
fn check_windows(app: &AppHandle, state: &AppState, root: &Path, first: &Path, _second: &Path) -> Result<Value, String> {
    if !cfg!(feature = "windows-offline") || python_sandbox::status().available || detect_codex_runtime_internal().available {
        return Err("安装程序未进入 Windows 离线工具模式".into());
    }
    let creds: i64 = state.db.lock().query_row(
        "SELECT count(*) FROM ai_profiles WHERE id='zhai-tianyi' OR key_stored=1", [], |r| r.get(0)
    ).map_err(|e| e.to_string())?;
    if creds != 0 { return Err("全新离线安装发现模型授权".into()); }
    let sheets = root.join("xlsx-fixtures");
    run_fixture_script(&root.join("make-xlsx"), r#"from openpyxl import Workbook
from docx import Document
import base64
import zlib
from io import BytesIO
def run(context, params):
    outputs = []
    for name, rows in [('a', [['单位', '人数'], ['甲单位', 12]]), ('b', [['人数', '单位'], [8, '乙单位']])]:
        book = Workbook()
        for row in rows:
            book.active.append(row)
        path = context.output_dir / (name + '.xlsx')
        book.save(path)
        outputs.append(str(path))
    book = Workbook()
    for sheet, title, value in [(book.active, '甲表', 12), (book.create_sheet(), '乙表', 34)]:
        sheet.title = title
        sheet['A1'], sheet['A2'], sheet['B2'] = '合计', value, '=A2+1'
    path = context.output_dir / '多工作表.xlsx'
    book.save(path)
    outputs.append(str(path))
    pixel = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/SsQAAAAASUVORK5CYII=')
    for i in (1, 2):
        doc = Document()
        doc.add_heading(f'第{i}章', level=1)
        doc.add_paragraph(f'正文标记{i}').runs[0].bold = True
        doc.add_table(1, 1).cell(0, 0).text = f'表格标记{i}'
        doc.add_picture(BytesIO(pixel))
        path = context.output_dir / f'0{i}.docx'
        doc.save(path)
        outputs.append(str(path))
    # A real OLE Word 97 document, made with textutil from two synthetic lines:
    # "Office compatibility sample 6247" and "旧格式转换验收".
    legacy = context.output_dir / 'legacy.doc'
    legacy.write_bytes(zlib.decompress(base64.b64decode(
        b'eNrtnE1ME0EUx//dlkIR6AKKFfxANCrRGFT8OBiDUVHRAIqJRy3IV9KKwaJy42LiwUSNBxNjYiDxZGI0Eq+iB2'
        b'9+XDjICU+GRCNy4yDrf2anUr6kEKPUvt/m7czO7M5M38zsvtns64f3+cO9z4o/YRoH4MWEE4A/Ic1DWR8/sIEN'
        b'Jm3CcRyVVEpxhJTiy6NXpkNHC166vZzPTvWojj9NycMFgjkoUieg4Zor5fg9jhOcNx4novd95qgP86POWY7keU'
        b'HJobw2YZxvakTj3/GVU6rUmjweoqyAsNR5N20cCcLSpw4t3NrRhGY+v5vQgSguIYwY0xopEUoM3cy7zFSVF9Fn'
        b'7sFOVGIvcvG5eX9b8FzkVmPTzft7mnNFpamFec6PiybShJy6Gi9OUQ7VhCbtvBFRzH8CbfLcN5uQU2Gd9932D2'
        b'SNZpfm1gd78p8WDq+wQ1XFU07+1f9CWuIRFaQ3BQgim8OgnaEFr94qgarvjqVC3h5qaRN20vIL6zW5pVfZ6tGh'
        b'HiP15lESPRbwzSx7Pw5WjTm9DNVd6TDtxhaW0sVyYrQg6xnvpLTq/SW0Ma2adV1k7nTKzXsC9Z5J781dy5dgwW'
        b'QkxNUNzbKnXOy+yVIXHPXfTmrYn6FSomz0ZTasluFVhqe1gRxmI4HdLMdKopwGms9RGtMdWoG7kqz9INXSbpSe'
        b'bIuPsZURXOE+pk36MFt8krFWKjemX9D5UJF1I4TRD2x4my5z6ERkk5KZdwOPPvbBa3tmpMZTSr0YtWUWLZJH/o'
        b'HMfvSjBwUVf750NTbLJqcl+ylLVC4IgiAIgiAI6cwEV9S+7JmrS5UyfP3h2Hhdm/34Tha2bn7+Ua1RQiZPiW0W'
        b'GSM/RI+CIAiCIAiCIAiCkKrrf2vw7eCD7SX23Xtc/28bfyLrf0EQBEEQBEEQBEFITTxmDe+F+3G8+opefSmfCf'
        b'd/HQIMsynL4Ho3K//OPErQ5OdD+RAAhXC975WnehFlpclfxVC5HJVQVlPWUNZS1pl8JWUJ8Qn5S4a/inJo6ND+'
        b'GEe050Unuhc0foqQ4YmXpcaQP+C6RAy42dWzXbOR0mPiO3AGYTRqr+LFkMfRm/h7krlGfwZvvBbOau+WCzjMsA'
        b'ld2uFjNg+UuSiG5VFzaCH1I6H+DDToWqPaG6Ybx1l7yy+PG+XG0aGdTeZiC+u3zNxNtn57Sv3Tf/nC2rOP9S9U'
        b'/6GE+gVBEIR/w0/ysRu9'
    )))
    outputs.append(str(legacy))
    return {'summary':'合成表格', 'outputs':outputs}
"#, &root.join("empty"), &sheets)?;
    let version = app.package_info().version.to_string();
    let legacy_only = std::env::args().any(|arg| arg == "--legacy-doc-only");
    let converter = builtin_tools().into_iter().find(|t| t.id == "doc_to_docx").ok_or("缺少 DOC 转换能力注册")?;
    let legacy_inputs = [sheets.join("legacy.doc")];
    let legacy_check = if converter.available {
        let path = windows_manual_output(app, state, "doc_to_docx", &legacy_inputs)?;
        let legacy_dir = root.join("converted-doc");
        fs::create_dir_all(&legacy_dir).map_err(|e| e.to_string())?;
        fs::copy(path, legacy_dir.join("converted.docx")).map_err(|e| e.to_string())?;
        run_fixture_script(&root.join("verify-legacy"), r#"from docx import Document
def run(context, params):
    [doc] = context.inputs
    text = '\n'.join(p.text for p in Document(doc).paragraphs)
    assert 'Office compatibility sample 6247' in text and '旧格式转换验收' in text, text
    return {'summary':'中英文正文重开验证通过','outputs':[]}
"#, &legacy_dir, &root.join("verify-legacy/output"))?;
        "本机转换器已将二进制 DOC 转为 DOCX 并复核内容"
    } else {
        if legacy_only { return Err(format!("安装转换器后仍不可用：{}", converter.availability_detail)); }
        if windows_manual_output(app, state, "doc_to_docx", &legacy_inputs).is_ok() {
            return Err("无可用转换器时 DOC 转换错误地报告成功".into());
        }
        "本机未检测到可用转换器，仅验证 DOC 转换不可用提示"
    };
    if legacy_only {
        return Ok(json!({"success":true,"version":version,"edition":"windows-offline","platform":"windows",
            "legacyDocConverted":true,"checks":[legacy_check,"原文件 SHA-256 不变"]}));
    }
    let mut failures = Vec::new();
    let verify = root.join("office-results");
    fs::create_dir_all(&verify).map_err(|e| e.to_string())?;
    let word = windows_manual_output(app, state, "docx_to_gongwen", &[first.to_path_buf()]);
    let excel = windows_manual_output(app, state, "merge_xlsx", &[sheets.join("a.xlsx"), sheets.join("b.xlsx")]);
    for (name, result) in [("word.docx", word), ("excel.xlsx", excel)] {
        match result {
            Ok(path) => { fs::copy(path, verify.join(name)).map_err(|e| e.to_string())?; },
            Err(error) => failures.push(error),
        }
    }
    if let Err(error) = check_pdf_merge_delivery(app, state, root) { failures.push(error); }
    if !failures.is_empty() { return Err(failures.join("\n")); }
    let office_inputs = [sheets.join("02.docx"), sheets.join("01.docx")];
    let merged = windows_manual_output(app, state, "merge_docx", &office_inputs)?;
    fs::copy(&merged, verify.join("merged.docx")).map_err(|e| e.to_string())?;
    let text_doc = windows_manual_output(app, state, "extract_docx_text", &office_inputs[1..])?;
    fs::copy(&text_doc, verify.join("word.txt")).map_err(|e| e.to_string())?;
    let excel_text = windows_manual_output(app, state, "extract_xlsx_text", &[sheets.join("多工作表.xlsx")])?;
    fs::copy(excel_text, verify.join("excel.txt")).map_err(|e| e.to_string())?;
    let changed = windows_manual_outputs(app, state, "replace_text", &office_inputs[1..],
        json!({"before":"正文标记1","after":"已改正文"}), 1)?;
    fs::copy(&changed[0], verify.join("edited.docx")).map_err(|e| e.to_string())?;
    let numbered = windows_manual_output(app, state, "center_docx_page_numbers", &office_inputs[1..])?;
    fs::copy(numbered, verify.join("page-number.docx")).map_err(|e| e.to_string())?;
    for (skill, input, extension) in [
        ("split_docx", merged, "docx"),
        ("split_xlsx", sheets.join("多工作表.xlsx"), "xlsx")
    ] {
        let outputs = windows_manual_outputs(app, state, skill, &[input], json!({}), 2)?;
        for (index, path) in outputs.iter().enumerate() {
            fs::copy(path, verify.join(format!("part-{index}.{extension}"))).map_err(|e| e.to_string())?;
        }
    }
    run_fixture_script(&root.join("verify-office"), r#"from docx import Document
from openpyxl import load_workbook
def run(context, params):
    by_name = {path.name:path for path in context.inputs}
    doc = Document(by_name['word.docx'])
    assert doc.paragraphs[0].text == '测试通知'
    assert doc.paragraphs[0].alignment == 1, '标题未居中'
    assert any(r.bold for p in doc.paragraphs if '报送材料' in p.text for r in p.runs), '加粗正文未保留'
    book = load_workbook(by_name['excel.xlsx'], data_only=True)
    rows = list(book.active.values)
    book.close()
    columns = list(rows[0])
    assert {r[columns.index('单位')]:r[columns.index('人数')] for r in rows[1:]} == {'甲单位':12,'乙单位':8}, rows
    assert any('来源' in str(h) for h in columns), columns
    text = by_name['word.txt'].read_text(encoding='utf-8-sig')
    assert text.index('第1章') < text.index('正文标记1') < text.index('表格标记1'), text
    cells = by_name['excel.txt'].read_text(encoding='utf-8-sig')
    assert cells.index('甲表') < cells.index('乙表') and all(value in cells for value in ('合计','12','34','=A2+1')), cells
    edited = Document(by_name['edited.docx'])
    assert [p.text for p in edited.paragraphs if p.text] == ['第1章', '已改正文']
    footer = Document(by_name['page-number.docx']).sections[0].footer
    assert any(p.alignment == 1 and 'PAGE' in [
        value.strip() for value in p._p.xpath('.//w:fldSimple/@w:instr')
    ] for p in footer.paragraphs), '没有找到居中 PAGE 域'
    merged = Document(by_name['merged.docx'])
    assert [p.text for p in merged.paragraphs if p.style.name == 'Heading 1'] == ['第1章', '第2章']
    assert [t.cell(0, 0).text for t in merged.tables] == ['表格标记1', '表格标记2']
    assert len(merged.inline_shapes) == 2
    chapters, sheets = set(), {}
    for i in range(2):
        chapter = Document(by_name[f'part-{i}.docx'])
        titles = [p.text for p in chapter.paragraphs if p.style.name == 'Heading 1']
        assert len(titles) == 1 and titles[0] in {'第1章','第2章'}, titles
        number = titles[0][1]
        body = [p for p in chapter.paragraphs if p.text == f'正文标记{number}']
        assert len(body) == 1 and any(r.bold for r in body[0].runs)
        assert [t.cell(0, 0).text for t in chapter.tables] == [f'表格标记{number}']
        assert len(chapter.inline_shapes) == 1
        assert not chapter.element.body.xpath('./w:p[last()]/w:r/w:br[@w:type="page"]'), '拆出的章末留有空白页'
        chapters.add(titles[0])
        workbook = load_workbook(by_name[f'part-{i}.xlsx'], data_only=False)
        assert len(workbook.sheetnames) == 1
        sheet = workbook.active
        assert sheet['B2'].value == '=A2+1'
        sheets[sheet.title] = sheet['A2'].value
        workbook.close()
    assert chapters == {'第1章','第2章'} and sheets == {'甲表':12,'乙表':34}
    return {'summary':'重新打开 Word 和 Excel 验收通过','outputs':[]}
"#, &verify, &root.join("verify-office/output"))?;
    Ok(json!({"success":true,"version":version,"legacyDocConverted":converter.available,"platform":"windows","edition":"windows-offline",
        "checks":["全新用户无天翼授权或已保存模型凭据","能力库正式入口完成 Word 公文排版，重新打开核对标题居中和正文加粗",
                  "能力库正式入口合并两份 Excel，核对列对齐、数值及来源","能力库正式入口合并 PDF，复核三页顺序",
                  "能力库正式入口提取 DOCX 正文和表格、精确替换正文、重开核对居中 PAGE 页码",
                  "逆序选材按文件名合并 Word，按一级标题拆分并核对图片、表格和加粗",
                  "导出 Excel 工作表文本、按工作表拆分，重新打开核对标题、数字和表内公式",
                  legacy_check,
                  "各项输入原件 SHA-256 保持一致"]}))
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
    insert_agent_message(&state,&session.id,"user","将本轮材料排版并追加核验结语",Some(turn))?;
    let scratch = PathBuf::from(&session.workspace_path)
        .join("runs")
        .join(turn)
        .join("scratch");
    let delivery = root.join("delivery");
    fs::create_dir_all(&scratch).map_err(|e| e.to_string())?;
    let contract = derive_task_contract("生成一份 Word 文档", attachments.len());
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
        &contract,
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
    let word_bridge = agent_tools::ToolSession::new(app, &state, &session, "word-structure-check", &Events, Arc::new(AtomicBool::new(false)), &word_scratch, &word_delivery, &attachments, &contract);
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
        let failing_test = json!({"diagnostic":true,"script":"def run(context):\n    raise ValueError('样本结构不符合本次试验')"});
        if rpc(10, "run_python", failing_test.clone()).is_ok() { return Err("失败试验未返回实际错误".into()); }
        let progress = word_bridge.recovery_progress();
        if rpc(11, "run_python", failing_test).is_ok() || progress != word_bridge.recovery_progress() {
            return Err("重复失败试验被当作新进展".into());
        }
        rpc(12, "run_python", json!({"script":"def run(context):\n    path=context.output_dir / '试验.txt'\n    path.write_text('格式试验')\n    return {'summary':'试验','outputs':[str(path)]}"}))?;
        let rejected = rpc(13, "deliver", json!({"input":"previous"})).err().ok_or("错误格式被交付")?;
        if !rejected.contains("docx") || word_bridge.has_delivery() {
            return Err("错误格式未在本轮 MCP 内退回，或发布了试验成果".into());
        }
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
    checks.push("失败诊断和格式不符在同一 MCP 会话退回，随后换用定位编辑生成合格 DOCX");
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
    let delivered=fs::read_dir(&delivery).map_err(|e|e.to_string())?.map(|e|e.map(|e|e.path())).collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    publish_agent_artifacts(&state,&session,"本轮正式交付",&delivered)?;
    insert_agent_message(&state,&session.id,"assistant","本轮排版和核验已完成",Some(turn))?;
    let seed=workflow::task_skill_seed(&state,&session.id,turn)?;
    if seed["samplePaths"].as_array().is_none_or(|a|a.len()!=1) || !seed["prompt"].as_str().is_some_and(|s|s.contains("将本轮材料排版并追加核验结语") && s.contains("本轮排版和核验已完成")) || seed["requiresNetwork"]!=false {
        return Err("成功任务测试版种子没有保留当前需求/执行记录/样本或误标联网".into());
    }
    if workflow::task_skill_seed(&state,&session.id,"missing-turn").is_ok(){return Err("不存在的任务生成了测试版种子".into());}
    checks.push("成功任务以本轮需求、实际执行记录和样本生成测试版入口数据");
    let tool = workflow::promote(&state, &session.id, turn, Some("自检办公流程"))?;
    if tool.test_status.as_deref() != Some("untested") || tool.available {
        return Err("新工作流跳过了测试门槛".into());
    }
    checks.push("完整工作流保存为待测试草稿");
    let test_request:TestAndRepairRequest=serde_json::from_value(json!({"runId":"promoted-workflow-test","skillId":tool.id,"samplePaths":[first],"parameters":{},"repair":null})).map_err(|e|e.to_string())?;
    let tested=tauri::async_runtime::block_on(test_and_repair_skill_inner(test_request,app,&state,&Events))?;
    if tested.test_result.as_ref().is_none_or(|r|r.status!="passed"){return Err(format!("任务沉淀后的正式样本测试未通过：{}",serde_json::to_string(&tested.test_result).unwrap_or_default()));}
    let tool=publish_skill_inner(tool.id,&state)?;
    let replay_parameters=merge_agent_tool_parameters(&tool.id,&json!({}),std::slice::from_ref(&tool),"");
    checks.push("成功任务沉淀后经正式样本测试与发布门控");
    let (_summary, outputs) = execute_skill_pipeline(
        app,
        &state,
        &tool,
        std::slice::from_ref(&second),
        &replay_parameters,
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
    checks.extend(check_design_lifecycle(app, &state, root)?);
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
            attachment_ids:None,session_id:session.id.clone(), content:content.into(), profile_id:id.into(),
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
        let marker = PathBuf::from(&session.workspace_path).join("runs/harness-cancel/scratch/shell/cancel-pids.txt");
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
                attachment_ids:None,session_id:session.id.clone(), content:"协议取消验收：运行测试子进程，等待外部取消，不生成成果。".into(),
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

// Only the installed self-check uses this helper. The source is compiled into
// the application and never comes from a skill, a file attachment, or a model.
fn run_fixture_script(root: &Path, source: &'static str, inputs: &Path, outputs: &Path) -> Result<(), String> {
    for path in [root, inputs, outputs] {
        fs::create_dir_all(path).map_err(|e| e.to_string())?;
    }
    let script = root.join("fixture.py");
    let request = root.join("fixture-request.json");
    fs::write(&script, source).map_err(|e| e.to_string())?;
    write_json_atomic(&request, &json!({
        "schemaVersion":1, "neverOverwrite":true, "scriptPath":script,
        "inputDirectory":inputs, "outputDirectory":outputs, "parameters":{}
    }))?;
    let result = engine_command()?.arg("--run-agent-script").arg(request).output().map_err(|e| e.to_string())?;
    if !result.status.success() {
        return Err(format!("自检样本处理失败：{}", String::from_utf8_lossy(&result.stderr)));
    }
    Ok(())
}

fn check_pdf_merge_delivery(app: &AppHandle, state: &AppState, root: &Path) -> Result<(), String> {
    let fixtures = root.join("pdf-fixtures");
    run_fixture_script(&root.join("make-pdf-fixtures"), r#"from pypdf import PdfWriter
def run(context, params):
    outputs = []
    for name, width, count in [('b.pdf', 200, 2), ('a.pdf', 100, 1)]:
        writer = PdfWriter()
        for _ in range(count):
            writer.add_blank_page(width=width, height=300)
        path = context.output_dir / name
        with path.open('wb') as stream:
            writer.write(stream)
        outputs.append(str(path))
    return {'summary': 'PDF fixtures', 'outputs': outputs}
"#, &root.join("empty"), &fixtures)?;
    let inputs = vec![fixtures.join("b.pdf"), fixtures.join("a.pdf")];
    let before = inputs.iter().map(|p| sha256_file(p)).collect::<Result<Vec<_>,_>>()?;
    #[cfg(windows)]
    let outputs = vec![windows_manual_output(app, state, "merge_pdf", &inputs)?];
    #[cfg(not(windows))]
    let outputs = {
        let tool = builtin_tools().into_iter().find(|t| t.id == "merge_pdf").ok_or("missing merge_pdf")?;
        execute_skill_pipeline(app, state, &tool, &inputs, &json!({}), Arc::new(AtomicBool::new(false)), &root.join("pdf-merge"), 1, &mut HashSet::new())?.1
    };
    if outputs.len()!=1 { return Err(format!("PDF合并交付数量错误：{}", outputs.len())); }
    let verify_inputs = root.join("verify-pdf-merge/inputs");
    fs::create_dir_all(&verify_inputs).map_err(|e| e.to_string())?;
    fs::copy(&outputs[0], verify_inputs.join("merged.pdf")).map_err(|e| e.to_string())?;
    run_fixture_script(&root.join("verify-pdf-merge"), r#"from pypdf import PdfReader
def run(context, params):
    assert len(context.inputs) == 1
    reader = PdfReader(context.inputs[0])
    widths = [float(page.mediabox.width) for page in reader.pages]
    assert widths == [100, 200, 200], widths
    return {'summary': 'PDF三页及顺序通过', 'outputs': []}
"#, &verify_inputs, &root.join("verify-pdf-merge/output"))?;
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
    let state = AppState::open(root.join("online-data"))?;
    let (id, model) = copy_online_profile(app, &state, session_key.is_some())?;
    let session = create_pipeline_session(&state, &root.join("online-chat"), &[])?;
    let make_request = |session_id: String, content: &str, access: bool| SendAgentMessageRequest {
        session_id,
        content: content.into(),
        profile_id: id.clone(),
        model: model.clone(),
        api_key: session_key.clone(),
        allow_model_file_access: access,
        attachment_ids: None,
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
    let replay_parameters=merge_agent_tool_parameters(&workflow.id,&json!({}),std::slice::from_ref(&workflow),"");
    let (_, replay) = execute_skill_pipeline(
        app,
        &state,
        &workflow,
        &[root.join("fixtures/sample1.docx")],
        &replay_parameters,
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
