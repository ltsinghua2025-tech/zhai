//! Persistent design workspaces and sample execution share the production executor.
use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDesignState {
    pub design_id: String,
    #[serde(default)]
    pub skill_id: Option<String>,
    #[serde(default)]
    pub messages: Vec<DesignChatMessage>,
    #[serde(default)]
    pub attachment_roles: HashMap<String, String>,
    #[serde(default)]
    pub parameters: Value,
    #[serde(default)]
    pub test_result: Option<SkillTestResult>,
    #[serde(default)]
    pub source_task: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillTestResult {
    pub status: String,
    pub summary: String,
    pub output_directory: Option<String>,
    pub outputs: Vec<String>,
    pub parameters: Value,
    pub repairable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDesignRunResult {
    pub skill: AgentTool,
    pub test_result: Option<SkillTestResult>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignAndTestRequest {
    pub design: DesignToolRequest,
    pub run_id: String,
    #[serde(default)]
    pub sample_paths: Vec<String>,
    #[serde(default)]
    pub parameters: Value,
    #[serde(default)]
    pub auto_test: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestAndRepairRequest {
    pub run_id: String,
    pub skill_id: String,
    #[serde(default)]
    pub design_id: Option<String>,
    #[serde(default)]
    pub sample_paths: Vec<String>,
    #[serde(default)]
    pub parameters: Value,
    #[serde(default)]
    pub repair: Option<DesignToolRequest>,
}

pub(super) fn validate_design_identifier(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 128 || !value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return Err("设计会话标识无效".into());
    }
    Ok(())
}

fn valid_role(role: &str) -> bool {
    matches!(role, "sample_input" | "template" | "expected_output" | "reference")
}

pub(super) fn validate_design_attachments(attachments: &[DesignAttachment]) -> Result<(), String> {
    if attachments.len() > 100 { return Err("设计材料最多 100 份，请分批添加".into()); }
    for attachment in attachments {
        if !valid_role(&attachment.role) { return Err("设计附件用途无效".into()); }
        let path = Path::new(&attachment.path);
        reject_selected_symlink(path)?;
        if !path.is_absolute() || (!path.is_file() && !path.is_dir()) {
            return Err(format!("设计材料不可读：{}", path.display()));
        }
    }
    Ok(())
}

pub(super) async fn wait_for_cancellation(flag: Arc<AtomicBool>) {
    while !flag.load(Ordering::SeqCst) { tokio::time::sleep(Duration::from_millis(100)).await; }
}

fn ensure_state_table(state: &AppState) -> Result<(), String> {
    state.db.lock().execute_batch("CREATE TABLE IF NOT EXISTS skill_design_state (
        session_id TEXT PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
        design_id TEXT NOT NULL UNIQUE, state_json TEXT NOT NULL, updated_at TEXT NOT NULL
    );").map_err(|e| e.to_string())
}

pub(super) fn get_design_state_inner(state: &AppState, session_id: &str) -> Result<Option<SkillDesignState>, String> {
    load_agent_session(state, session_id)?;
    ensure_state_table(state)?;
    let raw = state.db.lock().query_row("SELECT state_json FROM skill_design_state WHERE session_id=?1", params![session_id], |r| r.get::<_,String>(0));
    match raw {
        Ok(raw) => serde_json::from_str(&raw).map(Some).map_err(|e| format!("无法读取设计会话：{e}")),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub(super) fn save_design_state_inner(state: &AppState, session_id: &str, mut design: SkillDesignState) -> Result<SkillDesignState, String> {
    load_agent_session(state, session_id)?;
    validate_design_identifier(&design.design_id)?;
    if design.messages.len() > 1000 || design.messages.iter().any(|m| !matches!(m.role.as_str(), "user" | "assistant")) {
        return Err("设计消息格式或数量无效".into());
    }
    if !design.parameters.is_null() && !design.parameters.is_object() { return Err("设计参数必须为对象".into()); }
    if design.attachment_roles.values().any(|role| !valid_role(role)) { return Err("设计样本用途无效".into()); }
    let ids = list_session_attachments(state, session_id)?.into_iter().map(|a| a.id).collect::<HashSet<_>>();
    design.attachment_roles.retain(|id, _| ids.contains(id));
    if let Some(test) = design.test_result.as_mut() {
        let root = state.data_dir.join("skill-tests");
        for path in test.outputs.iter().chain(test.output_directory.iter()) {
            let path = Path::new(path);
            if path.components().any(|c| matches!(c, std::path::Component::ParentDir)) || !path.starts_with(&root) {
                return Err("测试成果路径不属于本应用测试目录".into());
            }
            if path.exists() && !path.canonicalize().map_err(|e|e.to_string())?.starts_with(&root) { return Err("测试成果路径不属于本应用测试目录".into()); }
        }
        test.outputs.retain(|path| Path::new(path).is_file());
        if test.output_directory.as_deref().is_some_and(|path| !Path::new(path).is_dir()) { test.output_directory = None; }
    }
    if let Some(id) = design.skill_id.as_deref() {
        if !builtin_tools().iter().any(|t| t.id == id) && !designed_tools(state)?.iter().any(|t| t.id == id) { return Err("设计草稿不存在".into()); }
    }
    if let Some(source) = &design.source_task {
        let source_session = source["sessionId"].as_str().ok_or("来源任务缺少会话标识")?;
        let turn_id = source["turnId"].as_str().ok_or("来源任务缺少轮次标识")?;
        validate_design_identifier(turn_id)?;
        // A source chat can be deleted independently. Keep the editable
        // design and its copied samples; a stale origin is not a save error.
        if workflow::task_skill_seed(state, source_session, turn_id).is_err() { design.source_task = None; }
    }
    let raw = serde_json::to_string(&design).map_err(|e| e.to_string())?;
    if raw.len() > 4 * 1024 * 1024 { return Err("设计会话过长，请新建设计".into()); }
    ensure_state_table(state)?;
    state.db.lock().execute("INSERT INTO skill_design_state(session_id,design_id,state_json,updated_at) VALUES(?1,?2,?3,?4)
        ON CONFLICT(session_id) DO UPDATE SET design_id=excluded.design_id,state_json=excluded.state_json,updated_at=excluded.updated_at",
        params![session_id, design.design_id, raw, Utc::now().to_rfc3339()]).map_err(|e| format!("无法保存独立设计会话：{e}"))?;
    Ok(design)
}

#[tauri::command]
pub(super) fn get_skill_design_state(session_id: String, state: State<'_, AppState>) -> Result<Option<SkillDesignState>, String> {
    get_design_state_inner(&state, &session_id)
}

#[tauri::command]
pub(super) fn save_skill_design_state(session_id: String, design_state: SkillDesignState, state: State<'_, AppState>) -> Result<SkillDesignState, String> {
    save_design_state_inner(&state, &session_id, design_state)
}

struct RunGuard<'a> { state: &'a AppState, keys: Vec<String> }
impl Drop for RunGuard<'_> {
    fn drop(&mut self) { let mut map = self.state.skill_design_cancellations.lock(); for key in &self.keys { map.remove(key); } }
}

fn begin_run<'a>(state: &'a AppState, run_id: &str, design_id: Option<&str>, skill_id: Option<&str>) -> Result<(Arc<AtomicBool>, RunGuard<'a>), String> {
    validate_design_identifier(run_id)?;
    let mut keys = vec![run_id.to_string()];
    if let Some(id) = design_id { validate_design_identifier(id)?; keys.push(format!("design:{id}")); }
    if let Some(id) = skill_id { keys.push(format!("skill:{id}")); }
    let flag = Arc::new(AtomicBool::new(false));
    let mut running = state.skill_design_cancellations.lock();
    if keys.iter().any(|key| running.contains_key(key)) { return Err("这份能力包正在设计或测试，请先等待完成或停止".into()); }
    for key in &keys { running.insert(key.clone(), flag.clone()); }
    Ok((flag, RunGuard { state, keys }))
}

struct ProgressOnly<'a, S>(&'a S);
impl<S: EventSink<SkillDesignEvent>> EventSink<SkillDesignEvent> for ProgressOnly<'_, S> {
    fn send(&self, event: SkillDesignEvent) -> Result<(), String> {
        match event {
            SkillDesignEvent::Started { .. } | SkillDesignEvent::Completed { .. } | SkillDesignEvent::Failed { .. } | SkillDesignEvent::Cancelled => Ok(()),
            other => self.0.send(other),
        }
    }
}

fn phase(events: &impl EventSink<SkillDesignEvent>, name: &str, message: &str) {
    let _ = events.send(SkillDesignEvent::Phase { phase: name.into(), message: message.into(), elapsed_seconds: 0 });
}

fn test_result(status: &str, summary: String, parameters: Value, repairable: bool) -> SkillTestResult {
    SkillTestResult { status: status.into(), summary, output_directory: None, outputs: vec![], parameters, repairable }
}

fn load_tool(state: &AppState, id: &str) -> Result<AgentTool, String> {
    designed_tools(state)?.into_iter().map(normalize_skill_status).find(|t| t.id == id).ok_or_else(|| "只能测试自己创建的能力包".into())
}

pub(super) fn propagate_network_dependency(tool: &mut AgentTool, state: &AppState) -> Result<(), String> {
    let catalog = builtin_tools().into_iter().chain(designed_tools(state)?).collect::<Vec<_>>();
    apply_network_dependency(tool, &catalog);
    Ok(())
}

/// Pure metadata view: callers can use one loaded catalog for an entire list.
/// This does not rewrite packages or indexes, and builtins keep their lifecycle.
pub(super) fn apply_network_dependency(tool: &mut AgentTool, catalog: &[AgentTool]) {
    fn needs_network(tool: &AgentTool, catalog: &[AgentTool], visited: &mut HashSet<String>) -> bool {
        if tool.requires_network || tool.permissions.iter().any(|p| p == "network") { return true; }
        if tool.source == "builtin" { return false; }
        if !visited.insert(tool.id.clone()) { return false; }
        let mut ids = tool.steps.iter().map(|s| s.tool_id.as_str()).collect::<Vec<_>>();
        if let Some(composition) = &tool.composition { ids.extend(composition.stages.iter().filter_map(|stage| match stage { SkillStage::Skill { skill_id, .. } => Some(skill_id.as_str()), _ => None })); }
        ids.extend(tool.dependencies.iter().map(String::as_str));
        ids.into_iter().any(|id| catalog.iter().find(|t| t.id == id).is_some_and(|t| needs_network(t,catalog,visited)))
    }
    if needs_network(tool, catalog, &mut HashSet::new()) {
        tool.requires_network = true;
        if !tool.permissions.iter().any(|p| p == "network") { tool.permissions.push("network".into()); }
        if tool.source == "builtin" { return; }
        tool.available = false;
        if tool.status.as_deref() == Some("published") { tool.status = Some("draft".into()); tool.test_status = Some("untested".into()); }
        if !tool.availability_detail.contains("联网") { tool.availability_detail.push_str("；依赖联网服务，当前自建能力执行器尚未接通该服务"); }
    }
}

fn sample_inputs(tool: &AgentTool, raw: &[String]) -> Result<Vec<PathBuf>, String> {
    if raw.len() > 100 { return Err("一次最多测试 100 份样本".into()); }
    if tool.supported_extensions.is_empty() && !raw.is_empty() {
        return Err("这份能力包无需原始样本，请移除样本后重新测试。".into());
    }
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    for name in raw {
        let path = Path::new(name);
        reject_selected_symlink(path)?;
        if !path.is_absolute() || !path.is_file() { return Err(format!("测试样本不可读：{name}")); }
        let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
        if !tool.supported_extensions.iter().any(|e| e.trim_start_matches('.').eq_ignore_ascii_case(&extension)) {
            return Err(format!("“{}”是 {} 文件，本能力支持 {}。请更换样本，或明确要求扩展支持格式。", path.file_name().unwrap_or_default().to_string_lossy(), extension.to_uppercase(), tool.supported_extensions.join("、").to_uppercase()));
        }
        let canonical = path.canonicalize().map_err(|e| e.to_string())?;
        if seen.insert(canonical.clone()) { paths.push(canonical); }
    }
    if paths.is_empty() && !tool.supported_extensions.is_empty() { return Err("请添加原始样本；模板、参考材料和正确成果不能代替测试输入".into()); }
    Ok(paths)
}

fn validate_parameter_values(tool: &AgentTool, supplied: &Value) -> Result<Value, String> {
    let values = checked_skill_parameters(tool, supplied)?;
    for field in &tool.parameters {
        let value = &values[&field.key];
        if value.is_null() { continue; }
        let valid = match field.parameter_type.as_str() {
            "number" => value.is_number(),
            "boolean" => value.is_boolean(),
            "text" => value.is_string(),
            "choice" => value.as_str().is_some_and(|v| field.choices.as_ref().is_some_and(|choices| choices.iter().any(|c| c == v))),
            _ => false,
        };
        if !valid { return Err(format!("请检查“{}”的参数类型或可选值", field.label)); }
    }
    // Declarative cross-field rules are package resources; no model or script runs for missing input.
    if let Some(root) = tool.package_path.as_deref() {
        let path = Path::new(root).join("references/parameter-rules.json");
        if path.is_file() {
            let rules: Value = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| format!("参数规则无效：{e}"))?;
            let object = rules.as_object().ok_or("参数规则必须为对象")?;
            if object.keys().any(|key| key != "atLeastOnePositive") { return Err("能力包含不支持的参数规则".into()); }
            if rules.get("atLeastOnePositive").is_some_and(|value| !value.is_array()) { return Err("参数规则必须为字段组数组".into()); }
            if let Some(groups) = rules["atLeastOnePositive"].as_array() {
                for group in groups {
                    let fields = group.as_array().ok_or("参数规则应为字段数组")?;
                    if fields.is_empty() || fields.iter().any(|key| !key.as_str().is_some_and(|key| tool.parameters.iter().any(|field| field.key == key && field.parameter_type == "number"))) {
                        return Err("参数规则必须引用已声明的数字字段".into());
                    }
                    if !fields.iter().filter_map(Value::as_str).any(|key| values[key].as_f64().is_some_and(|v| v > 0.0)) {
                        return Err(format!("请至少填写一个大于 0 的参数：{}", fields.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("、")));
                    }
                }
            }
        }
    }
    Ok(values)
}

fn is_input_or_environment_error(error: &str) -> bool {
    ["需要补充参数", "请至少填写", "请填写", "参数缺失", "未安装", "不可用", "缺少组件", "尚不支持", "格式不在", "缺少系统", "无法启动", "隔离器"].iter().any(|text| error.contains(text))
}

pub(super) fn execute_sample_test(
    state: &AppState, app: &AppHandle, mut tool: AgentTool, paths: &[String], supplied: &Value,
    cancellation: Arc<AtomicBool>, events: &impl EventSink<SkillDesignEvent>,
) -> Result<SkillDesignRunResult, String> {
    // Invalidate previous success before any early return; an old pass cannot publish new parameters.
    tool.available = false;
    tool.status = Some("draft".into());
    tool.test_status = Some("untested".into());
    tool.availability_detail = "正在准备样本测试".into();
    tool = save_designed_tool_internal(tool, state)?;
    let prepared = (|| {
        if tool.requires_network { return Err("这份能力包明确依赖联网；当前自建能力执行器尚未接通其外部服务，不能按离线能力测试或发布。请保留草稿。".into()); }
        if tool.kind.as_deref() == Some("adapter") { return Err("软件适配器需要目标环境实际接口验收，不能仅凭清单通过样本测试".into()); }
        let values = validate_parameter_values(&tool, supplied)?;
        let inputs = sample_inputs(&tool, paths)?;
        workflow::refresh_locks(&tool, state)?;
        Ok::<_, String>((values, inputs))
    })();
    let (parameters, inputs) = match prepared {
        Ok(prepared) => prepared,
        Err(reason) => {
            tool.availability_detail = reason.clone();
            tool = save_designed_tool_internal(tool, state)?;
            return Ok(SkillDesignRunResult { skill: tool, test_result: Some(test_result("needs_input", reason, supplied.clone(), false)) });
        }
    };
    if cancellation.load(Ordering::SeqCst) { return Ok(SkillDesignRunResult { skill: tool, test_result: Some(test_result("cancelled", "样本测试已停止".into(), parameters, false)) }); }
    let hashes = inputs.iter().map(|p| sha256_file(p).map(|hash| (p.clone(), hash))).collect::<Result<Vec<_>, _>>()?;
    let root = state.data_dir.join("skill-tests").join(format!("{}-{}", sanitize_task_name(&tool.id), Uuid::new_v4()));
    phase(events, "testing", "正在用正式文件引擎运行样本；原件只读");
    let execution = execute_skill_pipeline(app, state, &tool, &inputs, &parameters, cancellation.clone(), &root, 1, &mut HashSet::new());
    let unchanged = hashes.iter().all(|(p, before)| sha256_file(p).is_ok_and(|after| &after == before));
    let mut result = if cancellation.load(Ordering::SeqCst) {
        test_result("cancelled", "样本测试已停止，未发布测试成果".into(), parameters.clone(), false)
    } else if !unchanged {
        test_result("failed", "原始样本校验未通过，已阻止发布成果".into(), parameters.clone(), false)
    } else {
        match execution {
            Ok((summary, outputs)) if !outputs.is_empty() => {
                let final_root = root.join("测试成果");
                let collected = (|| -> Result<Vec<String>, String> {
                    fs::create_dir_all(&final_root).map_err(|e| e.to_string())?;
                    let mut finals = Vec::new();
                    for source in outputs {
                        if source.is_symlink() || !source.is_file() { return Err("测试成果不是有效文件".into()); }
                        let path = unique_artifact_path(&final_root, &source);
                        fs::copy(&source, &path).map_err(|e| e.to_string())?;
                        finals.push(path.to_string_lossy().to_string());
                    }
                    Ok(finals)
                })();
                match collected {
                    Ok(outputs) => SkillTestResult { status: "passed".into(), summary: format!("样本执行通过，生成 {} 份成果。{summary}", outputs.len()), output_directory: Some(final_root.to_string_lossy().to_string()), outputs, parameters: parameters.clone(), repairable: false },
                    Err(error) => test_result("failed", error, parameters.clone(), false),
                }
            }
            Ok(_) => test_result("failed", "能力包没有生成最终成果".into(), parameters.clone(), true),
            Err(error) => {
                let needs_input = is_input_or_environment_error(&error);
                test_result(if needs_input { "needs_input" } else { "failed" }, error, parameters.clone(), !needs_input)
            }
        }
    };
    // Keep the final test files, never put logs/intermediates in the normal delivery list.
    if result.status != "passed" { let _ = fs::remove_dir_all(&root); }
    else {
        if let Ok(entries) = fs::read_dir(&root) {
            for entry in entries.flatten() {
                if entry.file_name() != "测试成果" { let _ = if entry.path().is_dir() { fs::remove_dir_all(entry.path()) } else { fs::remove_file(entry.path()) }; }
            }
        }
        // Record the exact input/parameter provenance independently of model-authored test descriptions.
        let record = json!({"source":"zhai-sample-test","parameters":parameters,"inputs":hashes.iter().map(|(path,hash)| json!({"name":path.file_name().unwrap_or_default(),"sha256":hash})).collect::<Vec<_>>()});
        if let Some(package) = tool.package_path.as_deref() {
            let record_path = Path::new(package).join("tests/last-execution.json");
            if let Err(error) = write_json_atomic(&record_path, &record) { result = test_result("failed", error, parameters, false); let _ = fs::remove_dir_all(&root); }
        }
    }
    tool.test_status = Some(if result.status == "passed" { "passed" } else if result.status == "failed" { "failed" } else { "untested" }.into());
    tool.status = Some(if result.status == "failed" { "test_failed" } else { "draft" }.into());
    tool.availability_detail = result.summary.clone();
    let saved = save_designed_tool_internal(tool, state)?;
    Ok(SkillDesignRunResult { skill: saved, test_result: Some(result) })
}

async fn test_with_repair(
    mut tool: AgentTool, paths: &[String], parameters: &Value, repair: Option<DesignToolRequest>,
    app: &AppHandle, state: &AppState, cancellation: Arc<AtomicBool>, events: &impl EventSink<SkillDesignEvent>,
) -> Result<SkillDesignRunResult, String> {
    let mut result = execute_sample_test(state, app, tool.clone(), paths, parameters, cancellation.clone(), events)?;
    let failure = result.test_result.as_ref().filter(|test| test.repairable && test.status == "failed").map(|test| test.summary.clone());
    if let (Some(mut request), Some(failure)) = (repair, failure) {
        if cancellation.load(Ordering::SeqCst) { return Ok(result); }
        phase(events, "repairing", "样本运行失败，正在根据实际错误修复一次，随后重新测试");
        request.current_skill_id = Some(tool.id.clone());
        request.prompt = format!("修复当前能力包，保留原有功能、输入格式和用户参数，不得删除验收条件或伪造成功。实际样本测试失败：\n{failure}\n本轮用户参数：{}\n原始要求：{}\n只修正实现；如果缺少用户业务信息，通过明确参数校验返回，不要猜测。", parameters, request.prompt);
        // Repair the saved version, not an older design checkpoint.
        if let Some(id) = request.design_id.as_deref() {
            validate_design_identifier(id)?;
            let workspace = state.data_dir.join("skill-designs").join(id);
            if let Some(package) = tool.package_path.as_deref() {
                if workspace.exists() { fs::remove_dir_all(&workspace).map_err(|e| e.to_string())?; }
                copy_directory(Path::new(package), &workspace)?;
            }
        }
        let repaired = design_agent_tool_cancellable(request, state, &ProgressOnly(events), cancellation.clone(), Duration::from_secs(300)).await;
        match repaired {
            Ok(mut candidate) => {
                if candidate.id != tool.id { return Err("修复结果改变了能力包标识，已拒绝覆盖".into()); }
                candidate.available = false;
                candidate.status = Some("draft".into());
                candidate.test_status = Some("untested".into());
                tool = save_designed_tool_internal(candidate, state)?;
                result = execute_sample_test(state, app, tool, paths, parameters, cancellation, events)?;
                if let Some(test) = result.test_result.as_mut() { test.summary = format!("已自动修复一次并重测。{}", test.summary); }
            }
            Err(error) => {
                if let Some(test) = result.test_result.as_mut() {
                    if cancellation.load(Ordering::SeqCst) { test.status = "cancelled".into(); test.repairable = false; }
                    test.summary = format!("原测试失败：{failure}\n自动修复未完成：{error}。原草稿已保留，可继续修改。");
                }
            }
        }
    }
    Ok(result)
}

fn checkpoint_result(state: &AppState, design_id: Option<&str>, result: &SkillDesignRunResult) -> Result<(), String> {
    ensure_state_table(state)?;
    let records = {
        let db = state.db.lock();
        let mut query = db.prepare("SELECT session_id,state_json FROM skill_design_state").map_err(|e| e.to_string())?;
        let rows = query.query_map([], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?))).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>,_>>().map_err(|e| e.to_string())?
    };
    for (session_id, raw) in records {
        if let Ok(mut design) = serde_json::from_str::<SkillDesignState>(&raw) {
            if design_id == Some(design.design_id.as_str()) {
                design.skill_id = Some(result.skill.id.clone());
                design.test_result = result.test_result.clone();
                if let Some(test) = &result.test_result { design.parameters = test.parameters.clone(); }
                save_design_state_inner(state, &session_id, design)?;
            } else if design.skill_id.as_deref() == Some(result.skill.id.as_str())
                && result.skill.test_status.as_deref() != Some("passed") {
                // Invalidate a stale pass without borrowing another chat's
                // sample parameters or replacing its local test history.
                design.test_result = None;
                save_design_state_inner(state, &session_id, design)?;
            }
        }
    }
    Ok(())
}

pub(super) async fn design_and_test_skill_inner(request: DesignAndTestRequest, app: &AppHandle, state: &AppState, events: &impl EventSink<SkillDesignEvent>) -> Result<SkillDesignRunResult, String> {
    let (flag, _guard) = begin_run(state, &request.run_id, request.design.design_id.as_deref(), request.design.current_skill_id.as_deref())?;
    let _ = events.send(SkillDesignEvent::Started { design_id: request.run_id.clone() });
    let repair = request.design.clone();
    let tool = design_agent_tool_cancellable(request.design, state, &ProgressOnly(events), flag.clone(), Duration::from_secs(600)).await?;
    if flag.load(Ordering::SeqCst) { return Err("能力包设计已停止，工作区已保留".into()); }
    let saved = save_designed_tool_internal(tool, state)?;
    checkpoint_result(state, repair.design_id.as_deref(), &SkillDesignRunResult { skill: saved.clone(), test_result: None })?;
    let design_id = repair.design_id.clone();
    let result = if request.auto_test {
        test_with_repair(saved, &request.sample_paths, &request.parameters, Some(repair), app, state, flag, events).await?
    } else { SkillDesignRunResult { skill: saved, test_result: None } };
    checkpoint_result(state, design_id.as_deref(), &result)?;
    let _ = events.send(if result.test_result.as_ref().is_some_and(|t| t.status == "cancelled") { SkillDesignEvent::Cancelled } else { SkillDesignEvent::Completed { skill_id: result.skill.id.clone() } });
    Ok(result)
}

pub(super) async fn test_and_repair_skill_inner(request: TestAndRepairRequest, app: &AppHandle, state: &AppState, events: &impl EventSink<SkillDesignEvent>) -> Result<SkillDesignRunResult, String> {
    let design_id = request.design_id.clone().or_else(|| request.repair.as_ref().and_then(|r| r.design_id.clone()));
    if request.design_id.is_some() && request.repair.as_ref().and_then(|r| r.design_id.as_ref()).is_some_and(|id| Some(id) != request.design_id.as_ref()) { return Err("测试与修复的设计会话不一致".into()); }
    let (flag, _guard) = begin_run(state, &request.run_id, design_id.as_deref(), Some(&request.skill_id))?;
    let _ = events.send(SkillDesignEvent::Started { design_id: request.run_id.clone() });
    let tool = load_tool(state, &request.skill_id)?;
    let result = test_with_repair(tool, &request.sample_paths, &request.parameters, request.repair, app, state, flag, events).await?;
    checkpoint_result(state, design_id.as_deref(), &result)?;
    let _ = events.send(if result.test_result.as_ref().is_some_and(|t| t.status == "cancelled") { SkillDesignEvent::Cancelled } else { SkillDesignEvent::Completed { skill_id: result.skill.id.clone() } });
    Ok(result)
}

#[cfg(not(feature = "kylin-legacy"))]
#[tauri::command]
pub(super) async fn design_and_test_skill(request: DesignAndTestRequest, app: AppHandle, state: State<'_, AppState>, on_event: Channel<SkillDesignEvent>) -> Result<SkillDesignRunResult, String> {
    design_and_test_skill_inner(request, &app, &state, &on_event).await
}
#[cfg(feature = "kylin-legacy")]
#[tauri::command]
pub(super) async fn design_and_test_skill(request: DesignAndTestRequest, app: AppHandle, state: State<'_, AppState>, event_name: String) -> Result<SkillDesignRunResult, String> {
    let events = LegacyEventSink::new(app.clone(), event_name);
    design_and_test_skill_inner(request, &app, &state, &events).await
}
#[cfg(not(feature = "kylin-legacy"))]
#[tauri::command]
pub(super) async fn test_and_repair_skill(request: TestAndRepairRequest, app: AppHandle, state: State<'_, AppState>, on_event: Channel<SkillDesignEvent>) -> Result<SkillDesignRunResult, String> {
    test_and_repair_skill_inner(request, &app, &state, &on_event).await
}
#[cfg(feature = "kylin-legacy")]
#[tauri::command]
pub(super) async fn test_and_repair_skill(request: TestAndRepairRequest, app: AppHandle, state: State<'_, AppState>, event_name: String) -> Result<SkillDesignRunResult, String> {
    let events = LegacyEventSink::new(app.clone(), event_name);
    test_and_repair_skill_inner(request, &app, &state, &events).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn matrix_tool() -> AgentTool {
        serde_json::from_value(json!({
            "id":"designed-parameter-check","name":"矩阵","description":"测试参数","source":"designed",
            "kind":"python","supportedExtensions":["xlsx"],"available":false,"availabilityDetail":"草稿",
            "parameters":[
                {"key":"rows","label":"行数","type":"number","required":false,"defaultValue":0},
                {"key":"cols","label":"列数","type":"number","required":false,"defaultValue":0},
                {"key":"column","label":"数据列","type":"text","required":true,"defaultValue":null}
            ],"steps":[],"sourceCode":"def run(context, params):\n    return {'outputs': [], 'summary': str(context.output_dir)}"
        })).unwrap()
    }

    #[test]
    fn identifiers_and_roles_cannot_escape_design_workspace() {
        for id in ["", "../other", "/tmp/other", "a/b", "a\\b", "."] { assert!(validate_design_identifier(id).is_err(), "{id}"); }
        assert!(validate_design_identifier("design-123_a").is_ok());
        let input = DesignAttachment { path: "/tmp".into(), role: "../../escape".into() };
        assert!(validate_design_attachments(&[input]).is_err());
    }

    #[test]
    fn loading_legacy_packages_inherits_network_without_rewriting_them() {
        let root = std::env::temp_dir().join(format!("zhai-legacy-network-{}", Uuid::new_v4()));
        let state = AppState::open(root.join("data")).unwrap();
        let mut child = matrix_tool();
        child.id = "legacy-network-child".into();
        child.dependencies = vec!["citizen_reply".into()];
        child.status = Some("published".into()); child.test_status = Some("passed".into()); child.available = true;
        let mut parent = child.clone();
        parent.id = "legacy-network-parent".into(); parent.dependencies.clear();
        parent.kind = Some("workflow".into()); parent.source_code = None;
        parent.composition = Some(SkillComposition { schema_version: 2, version_policy: "latest_compatible".into(), stages: vec![SkillStage::Skill { skill_id: child.id.clone(), input: "original".into(), parameters: json!({}) }] });
        let mut hashes = Vec::new();
        // Bypass the current save normalization to represent packages written
        // by an older app: disk contracts explicitly claim no network.
        for tool in [&child, &parent] {
            let (path, hash) = write_skill_package(tool, &state).unwrap();
            state.db.lock().execute("INSERT INTO skill_index(id,name,version,status,package_path,package_hash,test_status,requires_network,created_at,updated_at) VALUES(?1,?2,'0.1.0','published',?3,?4,'passed',0,'legacy','legacy')",params![tool.id,tool.name,path.to_string_lossy(),hash]).unwrap();
            hashes.push((path, hash));
        }
        let catalog = loaded_skill_catalog(&state).unwrap();
        for id in [&child.id, &parent.id] {
            let tool = catalog.iter().find(|t| &t.id == id).unwrap();
            assert!(tool.requires_network && tool.permissions.iter().any(|p|p=="network"));
            assert!(!tool.available);
            assert_eq!(tool.status.as_deref(), Some("draft"));
        }
        let builtin = catalog.iter().find(|t|t.id=="citizen_reply").unwrap();
        assert_eq!(builtin.status.as_deref(),Some("published"));
        assert!(builtin.requires_network);
        assert!(!agent_tools_catalog(&state).unwrap().iter().any(|t|t.id==child.id || t.id==parent.id));
        for (path, hash) in hashes {
            assert_eq!(hash_skill_package(&path).unwrap(),hash);
            let original = read_skill_package(&path, Some(&hash)).unwrap();
            assert!(!original.requires_network);
            assert_eq!(original.status.as_deref(),Some("published"));
        }
        let flags: i64 = state.db.lock().query_row("SELECT SUM(requires_network) FROM skill_index",[],|row|row.get(0)).unwrap();
        assert_eq!(flags,0);
        drop(state); fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_or_wrong_type_parameters_are_input_errors() {
        let tool = matrix_tool();
        assert!(validate_parameter_values(&tool, &json!({"cols":3})).unwrap_err().contains("数据列"));
        assert!(validate_parameter_values(&tool, &json!({"column":"A","cols":"3"})).is_err());
        assert_eq!(validate_parameter_values(&tool, &json!({"column":"A","cols":3})).unwrap()["cols"],3);
    }

    #[test]
    fn cross_field_rules_reject_ambiguous_defaults_without_executing() {
        let root = std::env::temp_dir().join(format!("zhai-parameter-rules-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("references")).unwrap();
        write_json_atomic(&root.join("references/parameter-rules.json"), &json!({"atLeastOnePositive":[["rows","cols"]]})).unwrap();
        let mut tool = matrix_tool();
        tool.package_path = Some(root.to_string_lossy().to_string());
        assert!(validate_parameter_values(&tool, &json!({"column":"A"})).unwrap_err().contains("大于 0"));
        assert!(validate_parameter_values(&tool, &json!({"column":"A","cols":3})).is_ok());
        write_json_atomic(&root.join("references/parameter-rules.json"), &json!({"atLeastOnePositive":[["unknown"]]})).unwrap();
        assert!(validate_parameter_values(&tool, &json!({"column":"A","unknown":3})).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sample_format_mismatch_is_rejected_before_execution() {
        let path = std::env::temp_dir().join(format!("zhai-wrong-format-{}.csv", Uuid::new_v4()));
        fs::write(&path,"name\nA\n").unwrap();
        let result = sample_inputs(&matrix_tool(), &[path.to_string_lossy().to_string()]);
        assert!(result.unwrap_err().contains("CSV"));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn business_input_and_runtime_unavailability_are_not_code_repairs() {
        assert!(is_input_or_environment_error("ValueError: 需要补充参数：请选择工作表"));
        assert!(is_input_or_environment_error("本机隔离器不可用"));
        assert!(!is_input_or_environment_error("NameError: name 'rows_count' is not defined"));
    }
}
