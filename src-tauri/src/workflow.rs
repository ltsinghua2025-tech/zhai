use super::*;

pub(super) fn is_pipeline(tool: &AgentTool) -> bool {
    tool.kind.as_deref() == Some("derived")
        || (tool.kind.as_deref() == Some("workflow") && tool.composition.is_some())
}

pub(super) fn select_inputs(
    input: &str,
    originals: &[PathBuf],
    completed: &[Vec<PathBuf>],
) -> Result<Vec<PathBuf>, String> {
    match input {
        "original" => Ok(originals.to_vec()),
        "previous" => Ok(completed
            .last()
            .cloned()
            .unwrap_or_else(|| originals.to_vec())),
        value => value
            .strip_prefix("stage:")
            .and_then(|v| v.parse::<usize>().ok())
            .and_then(|n| n.checked_sub(1))
            .and_then(|index| completed.get(index))
            .cloned()
            .ok_or_else(|| "流程输入必须引用原始材料或已经完成的步骤".into()),
    }
}

pub(super) fn bind(value: &Value, parameters: &Value) -> Result<Value, String> {
    match value {
        Value::Object(map) if map.len() == 1 && map.contains_key("$param") => {
            let key = map["$param"].as_str().ok_or("参数引用必须是字符串")?;
            parameters
                .get(key)
                .cloned()
                .ok_or_else(|| format!("缺少工作流参数：{key}"))
        }
        Value::Object(map) => Ok(Value::Object(
            map.iter()
                .map(|(k, v)| Ok((k.clone(), bind(v, parameters)?)))
                .collect::<Result<_, String>>()?,
        )),
        Value::Array(values) => Ok(Value::Array(
            values
                .iter()
                .map(|v| bind(v, parameters))
                .collect::<Result<_, _>>()?,
        )),
        _ => Ok(value.clone()),
    }
}

pub(super) fn script(tool: &AgentTool, relative: &str, version: u32) -> Result<String, String> {
    if version == 1 {
        return tool
            .source_code
            .clone()
            .ok_or_else(|| "脚本阶段缺少源码".into());
    }
    let relative = Path::new(relative);
    if relative.is_absolute()
        || !relative.starts_with("scripts")
        || relative
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("流程脚本必须位于能力包 scripts 目录内".into());
    }
    let root = PathBuf::from(tool.package_path.as_deref().ok_or("工作流缺少能力包目录")?)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let path = root
        .join(relative)
        .canonicalize()
        .map_err(|e| format!("流程脚本不存在：{e}"))?;
    if !path.starts_with(&root) {
        return Err("脚本路径越出能力包".into());
    }
    let source = fs::read_to_string(path).map_err(|e| e.to_string())?;
    if source.len() > 200_000 || !source.contains("def run") || !source.contains("output_dir") {
        return Err("流程脚本需定义 run 并写入 context.output_dir，大小不超过 200 KB".into());
    }
    Ok(source)
}

pub(super) fn prepare_resources(
    tool: &AgentTool,
    state: &AppState,
    session: &AgentSession,
) -> Result<(), String> {
    let Some(package) = tool.package_path.as_deref() else {
        return Ok(());
    };
    let target = state
        .data_dir
        .join("sessions")
        .join(&session.id)
        .join("resources");
    for directory in ["assets", "references", "scripts"] {
        let source = Path::new(package).join(directory);
        if source.is_dir() {
            copy_directory(&source, &target.join(directory))?;
        }
    }
    Ok(())
}

pub(super) fn validate(tool: &AgentTool) -> Result<(), String> {
    let composition = tool.composition.as_ref().ok_or("工作流缺少步骤")?;
    if composition.schema_version != 2
        || composition.stages.is_empty()
        || composition.stages.len() > 32
    {
        return Err("新版工作流必须包含 1 至 32 个步骤".into());
    }
    for (index, stage) in composition.stages.iter().enumerate() {
        let input = match stage {
            SkillStage::Skill {
                skill_id, input, ..
            } => {
                if skill_id == &tool.id {
                    return Err("工作流不能引用自身".into());
                }
                input
            }
            SkillStage::Python {
                script: relative,
                input,
                ..
            } => {
                script(tool, relative, 2)?;
                input
            }
        };
        if input != "original" && input != "previous" {
            let stage = input
                .strip_prefix("stage:")
                .and_then(|s| s.parse::<usize>().ok())
                .ok_or("输入引用无效")?;
            if stage == 0 || stage > index {
                return Err("工作流不能引用未来步骤或自身成果".into());
            }
        }
    }
    Ok(())
}

pub(super) fn fingerprint(tool: &AgentTool) -> String {
    if tool.source == "builtin" {
        format!("builtin:{}:{}", tool.id, env!("CARGO_PKG_VERSION"))
    } else {
        tool.package_hash
            .clone()
            .unwrap_or_else(|| tool.version.clone().unwrap_or_default())
    }
}

pub(super) fn check_dependency(owner: &AgentTool, referenced: &AgentTool) -> Result<(), String> {
    if owner
        .composition
        .as_ref()
        .is_none_or(|c| c.version_policy != "locked")
    {
        return Ok(());
    }
    let path = PathBuf::from(owner.package_path.as_deref().ok_or("能力包目录缺失")?)
        .join("references/dependencies.json");
    let locks: Value = serde_json::from_str(
        &fs::read_to_string(path).map_err(|_| "能力依赖记录缺失，请重新测试")?,
    )
    .map_err(|e| e.to_string())?;
    if locks[&referenced.id].as_str() != Some(fingerprint(referenced).as_str()) {
        return Err(format!(
            "引用的能力“{}”已变化，请重新测试并发布工作流",
            referenced.name
        ));
    }
    Ok(())
}

pub(super) fn refresh_locks(tool: &AgentTool, state: &AppState) -> Result<(), String> {
    let Some(composition) = &tool.composition else {
        return Ok(());
    };
    if composition.version_policy != "locked" {
        return Ok(());
    }
    let mut locks = serde_json::Map::new();
    for stage in &composition.stages {
        if let SkillStage::Skill { skill_id, .. } = stage {
            let referenced = resolve_skill(state, skill_id)?;
            locks.insert(skill_id.clone(), json!(fingerprint(&referenced)));
        }
    }
    let root =
        PathBuf::from(tool.package_path.as_deref().ok_or("能力包目录缺失")?).join("references");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    write_json_atomic(&root.join("dependencies.json"), &Value::Object(locks))
}

pub(super) fn promote(
    state: &AppState,
    session_id: &str,
    turn_id: &str,
    name: Option<&str>,
) -> Result<AgentTool, String> {
    let session = load_agent_session(state, session_id)?;
    let trace_path = PathBuf::from(&session.workspace_path)
        .join("runs")
        .join(turn_id)
        .join("scratch/workflow-trace.json");
    let trace: Value = serde_json::from_str(
        &fs::read_to_string(&trace_path)
            .map_err(|_| "本轮没有可复用的工具流程，请通过能力工具完成文件任务后再保存")?,
    )
    .map_err(|e| e.to_string())?;
    let steps = trace["steps"].as_array().ok_or("缺少流程记录")?;
    if steps.is_empty() {
        return Err("本轮没有成功步骤".into());
    }
    if steps.iter().any(|step| step["requiresStructureRead"].as_bool() == Some(true)) {
        return Err("本轮含基于原文哈希的 Word 定位编辑，不能直接在其他材料重放；请通过设计能力包定义可复用的结构识别规则并实际测试".into());
    }
    let delivery = trace["delivery"]
        .as_str()
        .ok_or("本轮没有通过工具选定最终成果，不能直接沉淀")?;
    let final_stage = if delivery == "previous" {
        steps.len()
    } else {
        delivery
            .strip_prefix("stage:")
            .and_then(|s| s.parse::<usize>().ok())
            .ok_or("最终成果步骤无效")?
    };
    if final_stage == 0 || final_stage > steps.len() {
        return Err("最终成果步骤无效".into());
    }
    let id = format!("designed-{}", Uuid::new_v4());
    let seed = state.data_dir.join("skill-designs").join(&id);
    fs::create_dir_all(seed.join("scripts")).map_err(|e| e.to_string())?;
    fs::create_dir_all(seed.join("references")).map_err(|e| e.to_string())?;
    let mut stages = Vec::new();
    let mut locks = serde_json::Map::new();
    for (index, step) in steps.iter().take(final_stage).enumerate() {
        let input = step["input"].as_str().unwrap_or("original").to_string();
        if let Some(script) = step["script"].as_str() {
            if script.contains(&session.workspace_path)
                || script.contains(&state.data_dir.to_string_lossy().to_string())
            {
                return Err(
                    "脚本包含本轮固定路径，请在设计能力包中改为 context.inputs 后再保存".into(),
                );
            }
            let relative = format!("scripts/stage-{}.py", index + 1);
            fs::write(seed.join(&relative), script).map_err(|e| e.to_string())?;
            stages.push(SkillStage::Python {
                script: relative,
                input,
                parameters: step["parameters"].clone(),
                output_extensions: vec![],
            });
        } else {
            let tool: AgentTool =
                serde_json::from_value(step["tool"].clone()).map_err(|e| e.to_string())?;
            locks.insert(tool.id.clone(), json!(fingerprint(&tool)));
            stages.push(SkillStage::Skill {
                skill_id: tool.id,
                input,
                parameters: step["parameters"].clone(),
            });
        }
    }
    write_json_atomic(
        &seed.join("references/dependencies.json"),
        &Value::Object(locks),
    )?;
    let mut formats = list_session_attachments(state, session_id)?
        .iter()
        .filter(|a| a.kind != "artifact")
        .map(agent_attachment_extension)
        .filter(|e| !e.is_empty())
        .collect::<Vec<_>>();
    formats.sort();
    formats.dedup();
    let tool = AgentTool {
        id,
        name: name
            .filter(|n| !n.trim().is_empty())
            .unwrap_or("我的办公工作流")
            .chars()
            .take(48)
            .collect(),
        description: format!(
            "由已成功任务保存的 {} 步办公工作流。请换一组样本测试，确认规则适用于新材料后发布。",
            stages.len()
        ),
        source: "designed".into(),
        kind: Some("workflow".into()),
        version: Some("0.1.0".into()),
        author: Some("本机用户".into()),
        permissions: vec!["read_inputs".into(), "write_outputs".into()],
        source_code: None,
        test_status: Some("untested".into()),
        status: Some("draft".into()),
        supported_extensions: formats,
        available: false,
        availability_detail: "工作流已保存，请用新样本测试后发布".into(),
        parameters: vec![],
        steps: vec![],
        origin: None,
        requires_network: false,
        package_path: Some(seed.to_string_lossy().to_string()),
        package_hash: None,
        output_extensions: vec![],
        dependencies: vec![],
        acceptance: vec!["原件不变".into(), "最终文件可重新打开".into()],
        composition: Some(SkillComposition {
            schema_version: 2,
            version_policy: "locked".into(),
            stages,
        }),
    };
    save_designed_tool_internal(tool, state)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inputs_can_branch_to_a_previous_stage_but_not_forward() {
        let original = vec![PathBuf::from("original.docx")];
        let done = vec![
            vec![PathBuf::from("first.docx")],
            vec![PathBuf::from("second.pdf")],
        ];
        assert_eq!(select_inputs("stage:1", &original, &done).unwrap(), done[0]);
        assert_eq!(
            select_inputs("previous", &original, &done).unwrap(),
            done[1]
        );
        assert!(select_inputs("stage:3", &original, &done).is_err());
        assert!(select_inputs("stage:0", &original, &done).is_err());
    }
    #[test]
    fn parameter_binding_preserves_types_and_requires_values() {
        assert_eq!(
            bind(
                &json!({"count":{"$param":"n"},"label":"literal"}),
                &json!({"n":3})
            )
            .unwrap(),
            json!({"count":3,"label":"literal"})
        );
        assert!(bind(&json!({"$param":"missing"}), &json!({})).is_err());
    }
}
