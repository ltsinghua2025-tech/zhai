use super::*;

#[derive(Default)]
struct Memory {
    outputs: Vec<Vec<PathBuf>>,
    records: Vec<Value>,
    successful_calls: HashMap<String, Value>,
}

pub(super) struct ToolSession<'a> {
    pub app: &'a AppHandle,
    pub state: &'a AppState,
    pub session: &'a AgentSession,
    pub turn_id: &'a str,
    pub events: &'a dyn EventSink<AgentEvent>,
    pub cancellation: Arc<AtomicBool>,
    pub scratch: &'a Path,
    pub delivery: &'a Path,
    pub attachments: &'a [AgentAttachment],
    memory: Mutex<Memory>,
}

impl<'a> ToolSession<'a> {
    pub fn new(
        app: &'a AppHandle,
        state: &'a AppState,
        session: &'a AgentSession,
        turn_id: &'a str,
        events: &'a dyn EventSink<AgentEvent>,
        cancellation: Arc<AtomicBool>,
        scratch: &'a Path,
        delivery: &'a Path,
        attachments: &'a [AgentAttachment],
    ) -> Self {
        Self {
            app,
            state,
            session,
            turn_id,
            events,
            cancellation,
            scratch,
            delivery,
            attachments,
            memory: Mutex::new(Memory::default()),
        }
    }

    fn inputs(&self, selector: &str, memory: &Memory) -> Result<Vec<PathBuf>, String> {
        match selector {
            "original" => Ok(self
                .attachments
                .iter()
                .filter(|a| a.kind != "artifact")
                .filter_map(|a| a.local_snapshot_path.as_ref().map(PathBuf::from))
                .collect()),
            "previous" => memory
                .outputs
                .last()
                .cloned()
                .ok_or_else(|| "还没有上一步成果，请使用 original".into()),
            value => {
                let index = value
                    .strip_prefix("stage:")
                    .and_then(|s| s.parse::<usize>().ok())
                    .and_then(|n| n.checked_sub(1))
                    .ok_or("input 必须是 original、previous 或 stage:序号")?;
                memory
                    .outputs
                    .get(index)
                    .cloned()
                    .ok_or_else(|| "引用的步骤尚未运行".into())
            }
        }
    }

    pub fn dispatch(&self, name: &str, args: Value) -> Result<Value, String> {
        if self.cancellation.load(Ordering::SeqCst) {
            return Err("任务已取消".into());
        }
        match name {
            "list_materials" => Ok(
                json!({"materials": self.attachments.iter().map(|a| json!({"id":a.id,"name":a.name,"kind":a.kind,"size":a.size})).collect::<Vec<_>>()}),
            ),
            "read_material" => {
                let id = args["id"].as_str().ok_or("缺少材料 ID")?;
                let material = self
                    .attachments
                    .iter()
                    .find(|a| a.id == id)
                    .ok_or("材料不在本轮授权范围内")?;
                Ok(
                    json!({"text":read_local_agent_attachment(material)?.chars().take(24000).collect::<String>()}),
                )
            }
            "read_word_structure" => {
                let memory = self.memory.lock();
                let path = self.word_input(args["id"].as_str().ok_or("缺少材料 ID")?, &memory)?;
                self.word_request(&path, &args, None)
            }
            "edit_word" => self.edit_word(args),
            "search_skills" => {
                let query = args["query"].as_str().unwrap_or("").to_lowercase();
                let skills = agent_tools_catalog(self.state)?.into_iter().filter(|s| !s.requires_network && format!("{} {} {}",s.id,s.name,s.description).to_lowercase().contains(&query)).map(|s| json!({"id":s.id,"name":s.name,"description":s.description,"formats":s.supported_extensions})).collect::<Vec<_>>();
                Ok(json!({"skills":skills}))
            }
            "get_skill" => {
                let tool = resolve_skill(self.state, args["id"].as_str().ok_or("缺少能力 ID")?)?;
                if !tool.available || tool.status.as_deref() != Some("published") || !tool_runtime_available(self.state, &tool, &mut HashSet::new()) {
                    if tool.id == "ocr_pdf" && !tool.available {
                        return Err(tool.availability_detail.clone());
                    }
                    return Err("能力未发布或不可用".into());
                }
                Ok(
                    json!({"id":tool.id,"name":tool.name,"parameters":tool.parameters,"formats":tool.supported_extensions,"outputFormats":tool.output_extensions,"requiresNetwork":tool.requires_network}),
                )
            }
            "run_skill" | "run_python" => self.execute(name, args),
            "deliver" => self.deliver(args),
            _ => Err("未知工具".into()),
        }
    }

    fn word_input(&self, id: &str, memory: &Memory) -> Result<PathBuf, String> {
        if let Some(material) = self.attachments.iter().find(|a| a.id == id) {
            return material.local_snapshot_path.as_ref().map(PathBuf::from).ok_or("材料没有可读取的本地快照".into());
        }
        let indexes = id.strip_prefix("stage:").ok_or("材料不在本轮授权范围内")?.split(':').map(|n| n.parse::<usize>()).collect::<Result<Vec<_>, _>>().map_err(|_| "步骤成果 ID 无效")?;
        if indexes.len() != 2 || indexes[0] == 0 { return Err("步骤成果 ID 无效".into()); }
        memory.outputs.get(indexes[0] - 1).and_then(|v| v.get(indexes[1])).cloned().ok_or("步骤成果不在本轮范围内".into())
    }

    fn word_request(&self, input: &Path, args: &Value, output: Option<&Path>) -> Result<Value, String> {
        run_word_request(input, args, output, self.scratch, &self.cancellation)
    }

    fn edit_word(&self, args: Value) -> Result<Value, String> {
        let mut memory = self.memory.lock();
        if memory.outputs.len() >= 32 { return Err("本轮已达到 32 个成功步骤的限制".into()); }
        let input = self.word_input(args["id"].as_str().ok_or("缺少材料 ID")?, &memory)?;
        let signature = json!(["edit_word", args, input]).to_string();
        if let Some(result) = memory.successful_calls.get(&signature) { return Ok(result.clone()); }
        let filename = args["outputName"].as_str().unwrap_or("编辑成果.docx");
        if Path::new(filename).file_name().and_then(|s| s.to_str()) != Some(filename) || !filename.ends_with(".docx") { return Err("outputName 必须是单一 DOCX 文件名".into()); }
        let root = self.scratch.join(format!("word-edit-{}", Uuid::new_v4()));
        let output = root.join(filename);
        let run = insert_tool_run(self.state, &self.session.id, self.turn_id, "edit_word", "按定位编辑 Word", None)?;
        let _ = self.events.send(AgentEvent::ToolStarted { session_id:self.session.id.clone(), turn_id:self.turn_id.into(), run_id:run.id.clone(), tool_id:"edit_word".into(), summary:"按定位编辑 Word".into() });
        let execution = self.word_request(&input, &args, Some(&output)).and_then(|value| {
            validate_generated_artifact(&output)?;
            if self.cancellation.load(Ordering::SeqCst) { return Err("任务已取消".into()); }
            Ok(value)
        });
        let value = match execution {
            Ok(value) => value,
            Err(error) => {
                let _ = fs::remove_dir_all(root);
                finish_tool_run(self.state, &run.id, "failed", &error)?;
                let _ = self.events.send(AgentEvent::ToolFailed { session_id:self.session.id.clone(), turn_id:self.turn_id.into(), run_id:run.id, message:error.clone() });
                return Err(error);
            }
        };
        let step = memory.outputs.len() + 1;
        let summary = value["summary"].as_str().unwrap_or("Word 定位编辑完成");
        let result = json!({"success":true,"step":step,"summary":summary,"outputs":[{"id":format!("stage:{step}:0"),"path":output,"name":filename}]});
        memory.outputs.push(vec![output]);
        // Locator/hash edits deliberately cannot be replayed on different
        // documents without another structure read. Keep an explicit trace.
        memory.records.push(json!({"toolId":"edit_word","parameters":args,"input":"original","runId":run.id,"requiresStructureRead":true}));
        write_json_atomic(&self.scratch.join("workflow-trace.json"), &json!({"schemaVersion":1,"steps":memory.records,"inputIds":self.attachments.iter().filter(|a|a.kind!="artifact").map(|a|a.id.as_str()).collect::<Vec<_>>()}))?;
        memory.successful_calls.insert(signature, result.clone());
        finish_tool_run(self.state, &run.id, "completed", summary)?;
        let _ = self.events.send(AgentEvent::ToolProgress { session_id:self.session.id.clone(), turn_id:self.turn_id.into(), run_id:run.id, progress:100, detail:Some(summary.into()) });
        Ok(result)
    }

    fn execute(&self, name: &str, args: Value) -> Result<Value, String> {
        let mut memory = self.memory.lock();
        if memory.records.len() >= 32 {
            return Err("本轮已达到 32 个成功步骤的限制".into());
        }
        let input = args["input"].as_str().unwrap_or("original");
        let inputs = self.inputs(input, &memory)?;
        // Include resolved input paths: a 'previous' call after another step is
        // a different operation, even when its parameter JSON is unchanged.
        let signature = json!([name, args, inputs]).to_string();
        if let Some(result) = memory.successful_calls.get(&signature) {
            return Ok(result.clone());
        }
        let step = memory.outputs.len() + 1;
        let root = self.scratch.join(format!("tool-{step}-{}", Uuid::new_v4()));
        let parameters = args.get("parameters").cloned().unwrap_or(json!({}));
        let (tool, script) = if name == "run_skill" {
            let tool = resolve_skill(self.state, args["id"].as_str().ok_or("缺少能力 ID")?)?;
            if !tool.available || tool.status.as_deref() != Some("published") || !tool_runtime_available(self.state, &tool, &mut HashSet::new()) {
                return Err("能力尚未发布或不可用".into());
            }
            (Some(tool), None)
        } else {
            python_sandbox::require()?;
            let script = args["script"].as_str().ok_or("缺少完整 Python 源码")?;
            if script.len() > 200_000 {
                return Err("源码超过 200 KB".into());
            }
            (None, Some(normalize_agent_script(script)))
        };
        let label = tool
            .as_ref()
            .map(|t| t.name.clone())
            .unwrap_or_else(|| "运行临时文件工具".into());
        let tool_id = tool.as_ref().map(|t| t.id.as_str()).unwrap_or("run_python");
        let run = insert_tool_run(
            self.state,
            &self.session.id,
            self.turn_id,
            tool_id,
            &label,
            script.as_deref(),
        )?;
        let _ = self.events.send(AgentEvent::ToolStarted {
            session_id: self.session.id.clone(),
            turn_id: self.turn_id.into(),
            run_id: run.id.clone(),
            tool_id: tool_id.into(),
            summary: label,
        });
        let diagnostic = args["diagnostic"].as_bool().unwrap_or(false) && name == "run_python";
        let result = if let Some(tool) = &tool {
            let parameters =
                merge_agent_tool_parameters(&tool.id, &parameters, std::slice::from_ref(tool), "");
            execute_skill_pipeline(
                self.app,
                self.state,
                tool,
                &inputs,
                &parameters,
                self.cancellation.clone(),
                &root,
                1,
                &mut HashSet::new(),
            )
        } else {
            let session = create_pipeline_session(self.state, &root, &inputs)?;
            let _session_guard = PipelineSessionGuard(self.state, &session);
            let result = execute_dynamic_python_scoped(
                self.state,
                &session,
                self.turn_id,
                script.as_deref().unwrap(),
                Some(&parameters),
                self.cancellation.clone(),
                None,
                !diagnostic,
                diagnostic,
            )
            .map(|(summary, artifacts)| (summary, artifact_paths(&artifacts)));
            cleanup_pipeline_session(self.state, &session);
            result
        };
        let (summary, paths) = match result {
            Ok(v) if !self.cancellation.load(Ordering::SeqCst) => v,
            other => {
                let error = other.err().unwrap_or_else(|| "任务已取消".into());
                finish_tool_run(self.state, &run.id, "failed", &error)?;
                let _ = self.events.send(AgentEvent::ToolFailed {
                    session_id: self.session.id.clone(),
                    turn_id: self.turn_id.into(),
                    run_id: run.id,
                    message: error.clone(),
                });
                return Err(error);
            }
        };
        let result = json!({"success":true,"step":if diagnostic {Value::Null} else {json!(step)},"summary":summary.chars().take(24000).collect::<String>(),"outputs":paths.iter().enumerate().map(|(i,p)| json!({"id":format!("stage:{step}:{i}"),"path":p,"name":p.file_name().map(|s|s.to_string_lossy())})).collect::<Vec<_>>()});
        if !diagnostic {
            if paths.is_empty() {
                finish_tool_run(self.state, &run.id, "failed", "未生成成果")?;
                let _ = self.events.send(AgentEvent::ToolFailed {
                    session_id: self.session.id.clone(),
                    turn_id: self.turn_id.into(),
                    run_id: run.id.clone(),
                    message: "未生成成果".into(),
                });
                return Err("未生成成果，调查任务请设置 diagnostic=true".into());
            }
            let mut output_extensions: Vec<_> = paths.iter().filter_map(|p|p.extension().and_then(|v|v.to_str()).map(str::to_lowercase)).collect();
            output_extensions.sort(); output_extensions.dedup();
            memory.outputs.push(paths);
            memory.records.push(json!({"tool":tool,"script":script,"parameters":parameters,"input":input,"runId":run.id,"outputExtensions":output_extensions}));
            write_json_atomic(
                &self.scratch.join("workflow-trace.json"),
                &json!({"schemaVersion":1,"steps":memory.records,"inputIds":self.attachments.iter().filter(|a|a.kind!="artifact").map(|a|a.id.as_str()).collect::<Vec<_>>()}),
            )?;
            memory.successful_calls.insert(signature, result.clone());
        }
        finish_tool_run(self.state, &run.id, "completed", &summary)?;
        let notices = summary
            .lines()
            .filter(|line| {
                line.contains("字体提示：")
                    || line.contains("字体检查：")
                    || line.contains("占位日期")
                    || line.contains("排版提示：")
            })
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if !notices.is_empty() {
            let path = self.scratch.join("user-notices.json");
            let mut existing = fs::read_to_string(&path)
                .ok()
                .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
                .unwrap_or_default();
            existing.extend(notices);
            existing.sort();
            existing.dedup();
            write_json_atomic(&path, &json!(existing))?;
        }
        let _ = self.events.send(AgentEvent::ToolProgress {
            session_id: self.session.id.clone(),
            turn_id: self.turn_id.into(),
            run_id: run.id,
            progress: 100,
            detail: Some(summary.chars().take(200).collect()),
        });
        Ok(result)
    }

    fn deliver(&self, args: Value) -> Result<Value, String> {
        let memory = self.memory.lock();
        let selector = args["input"].as_str().unwrap_or("previous");
        if selector == "original" {
            return Err("原始材料不能作为新成果交付".into());
        }
        let paths = self.inputs(selector, &memory)?;
        for path in &paths {
            validate_generated_artifact(path)?;
        }
        if self.cancellation.load(Ordering::SeqCst) {
            return Err("任务已取消".into());
        }
        // Replacing a delivery selection only affects this turn's dedicated
        // staging directory. Existing session artifacts are never removed.
        fs::create_dir_all(self.delivery).map_err(|e| e.to_string())?;
        for entry in fs::read_dir(self.delivery).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.is_file() {
                fs::remove_file(path).map_err(|e| e.to_string())?;
            }
        }
        let mut delivered = Vec::new();
        for path in paths {
            let target = unique_artifact_path(self.delivery, &path);
            fs::copy(path, &target).map_err(|e| e.to_string())?;
            delivered.push(target);
        }
        write_json_atomic(
            &self.scratch.join("workflow-trace.json"),
            &json!({"schemaVersion":1,"steps":memory.records,"delivery":selector,"inputIds":self.attachments.iter().filter(|a|a.kind!="artifact").map(|a|a.id.as_str()).collect::<Vec<_>>()}),
        )?;
        Ok(json!({"success":true,"outputs":delivered}))
    }
}

pub(super) fn definitions() -> Value {
    definitions_for_python(python_sandbox::status().available)
}

fn definitions_for_python(python_available: bool) -> Value {
    let input = json!({"type":"string","description":"输入范围：original 原始材料，previous 上一步成果，stage:1 第一步成果（序号从 1 开始）"});
    let make = |name: &str, description: &str, properties: Value, required: Vec<&str>| json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false}});
    let mut definitions = json!([
        make(
            "list_materials",
            "列出本轮授权材料，不读取正文",
            json!({}),
            vec![]
        ),
        make(
            "read_material",
            "按材料 ID 抽样读取正文，长文本最多返回 24000 字符",
            json!({"id":{"type":"string"}}),
            vec!["id"]
        ),
        make(
            "read_word_structure",
            "读取 DOCX 正文、表格、嵌套表格、合并格与段落定位，返回 sourceHash。id 为授权材料 ID 或 stage:1:0 成果 ID；不猜测缺失字段",
            json!({"id":{"type":"string"}}),
            vec!["id"]
        ),
        make(
            "edit_word",
            "按 read_word_structure 的精确 locator、expected 原文与 sourceHash 编辑 DOCX 并保留未改格式。每项只编辑单段纯文字；拒绝字段/图片/链接/修订/控件及合并续格。新文字必须来源于授权材料或用户，缺项保留并报告。成果重开后暂存，随后 deliver 交付。定位编辑暂不支持直接保存为可复用能力",
            json!({"id":{"type":"string"},"sourceHash":{"type":"string"},"outputName":{"type":"string"},"edits":{"type":"array","minItems":1,"maxItems":500,"items":{"type":"object","properties":{"locator":{"type":"string"},"expected":{"type":"string"},"text":{"type":"string"}},"required":["locator","expected","text"],"additionalProperties":false}}}),
            vec!["id","sourceHash","edits"]
        ),
        make(
            "search_skills",
            "查找已发布的离线能力，query 留空列出全部",
            json!({"query":{"type":"string"}}),
            vec![]
        ),
        make(
            "get_skill",
            "读取能力的参数、输入格式和联网要求",
            json!({"id":{"type":"string"}}),
            vec!["id"]
        ),
        make(
            "run_skill",
            "通过 zhai 执行器运行已发布能力，返回经过验收的暂存成果。支持原始材料或之前步骤成果作为输入",
            json!({"id":{"type":"string"},"input":input,"parameters":{"type":"object"}}),
            vec!["id"]
        ),
        make(
            "run_python",
            "在 zhai 隔离环境执行临时 Python。定义 run(context, params)。context.inputs 是 list[pathlib.Path]，不是字典；context.output_dir 是 pathlib.Path。读取如 Document(context.inputs[0])，保存新文件如 context.output_dir / '成果.docx'，返回 {'summary':'说明','outputs':[str(path)]}。内置 python-docx、docxcompose、openpyxl、pypdf、pdfplumber、reportlab、lxml。调查时 diagnostic=true 可无成果",
            json!({"script":{"type":"string"},"input":input,"parameters":{"type":"object"},"diagnostic":{"type":"boolean"}}),
            vec!["script"]
        ),
        make(
            "deliver",
            "选择某一步的全部成果作为本轮最终交付。完成文件任务前必须调用。中间成果不会进入用户成果栏",
            json!({"input":input}),
            vec![]
        )
    ]);
    if !python_available {
        definitions.as_array_mut().unwrap().retain(|tool| tool["name"] != "run_python");
    }
    definitions
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unavailable_python_is_not_exposed_but_deterministic_word_tools_remain() {
        let tools = definitions_for_python(false);
        let names = tools.as_array().unwrap().iter().filter_map(|t| t["name"].as_str()).collect::<Vec<_>>();
        assert!(!names.contains(&"run_python"));
        assert!(names.contains(&"read_word_structure"));
        assert!(names.contains(&"edit_word"));
        let available = definitions_for_python(true);
        assert!(available.as_array().unwrap().iter().any(|t| t["name"] == "run_python"));
    }
}
