use super::*;

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("zhai-import-qa-{}", Uuid::new_v4()));
        fs::create_dir(&path).expect("create isolated import test root");
        Self(path)
    }

    fn create_file(&self, relative: &str, bytes: &[u8]) -> PathBuf {
        let path = self.0.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, bytes).unwrap();
        path
    }

    fn setup(&self) -> (AppState, AgentSession) {
        let state = AppState::open(self.0.join("data")).unwrap();
        let session = create_pipeline_session(&state, &self.0.join("workspace"), &[]).unwrap();
        (state, session)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn file(path: &Path) -> AgentAttachmentInput {
    AgentAttachmentInput::File { path: path.to_string_lossy().into_owned() }
}

fn folder(path: &Path) -> AgentAttachmentInput {
    AgentAttachmentInput::Folder { path: path.to_string_lossy().into_owned() }
}

fn import(state: &AppState, session: &AgentSession, items: Vec<AgentAttachmentInput>) -> Result<Vec<AgentAttachment>, String> {
    add_agent_attachments_inner(
        AddAgentAttachmentsRequest { session_id: session.id.clone(), items, deduplicate_samples: true },
        state,
    )
}

fn assert_snapshot(state: &AppState, session: &AgentSession, source: &Path, item: &AgentAttachment) {
    let snapshot = Path::new(item.local_snapshot_path.as_deref().unwrap());
    let snapshot_dir = state.data_dir.join("sessions").join(&session.id).join("inputs");
    assert!(snapshot.starts_with(snapshot_dir));
    assert_ne!(source, snapshot);
    assert_eq!(sha256_file(source).unwrap(), sha256_file(snapshot).unwrap());
    assert_eq!(item.sha256.as_deref(), Some(sha256_file(source).unwrap().as_str()));
}

#[cfg(unix)]
#[test]
fn selected_symlinks_reject_mixed_batch_before_any_snapshot() {
    use std::os::unix::fs::symlink;

    let scratch = Scratch::new();
    let (state, session) = scratch.setup();
    let actual = scratch.create_file("materials/原表.XLSM", b"synthetic workbook bytes");
    let digest = sha256_file(&actual).unwrap();
    let linked_file = scratch.0.join("链接.XLSM");
    let broken_file = scratch.0.join("失效.XLSM");
    let linked_folder = scratch.0.join("目录链接");
    symlink(&actual, &linked_file).unwrap();
    symlink(scratch.0.join("missing.xlsx"), &broken_file).unwrap();
    symlink(actual.parent().unwrap(), &linked_folder).unwrap();
    let linked_folder_with_separator = format!("{}/", linked_folder.display());
    let snapshot_dir = state.data_dir.join("sessions").join(&session.id).join("inputs");
    for invalid in [
        file(&linked_file),
        file(&broken_file),
        file(&linked_folder),
        AgentAttachmentInput::Folder { path: linked_folder_with_separator },
    ] {
        let error = import(&state, &session, vec![file(&actual), invalid]).unwrap_err();
        assert!(error.contains("符号链接") && error.contains("实际文件或文件夹"), "{error}");
        assert!(list_session_attachments(&state, &session.id).unwrap().is_empty());
        assert_eq!(fs::read_dir(&snapshot_dir).unwrap().count(), 0);
    }
    assert_eq!(sha256_file(&actual).unwrap(), digest);
}

#[test]
fn chat_folder_import_preflights_limits_filters_hidden_trees_and_rolls_back_sql_failures() {
    let scratch = Scratch::new();
    let (state, session) = scratch.setup();
    let batch = |items| add_agent_attachments_inner(AddAgentAttachmentsRequest {
        session_id: session.id.clone(), items, deduplicate_samples: false,
    }, &state);
    scratch.create_file("首批/.history/旧.txt", b"hidden");
    scratch.create_file("首批/~$旧稿/草稿.txt", b"temp");
    let original = scratch.create_file("首批/选中.txt", b"keep");
    let saved = batch(vec![folder(original.parent().unwrap())]).unwrap();
    assert_eq!(saved.len(), 1);
    assert_snapshot(&state, &session, &original, &saved[0]);
    for n in 0..1001 { scratch.create_file(&format!("超限/{n}.txt"), b"x"); }
    assert!(batch(vec![folder(&scratch.0.join("超限"))]).unwrap_err().contains("1000"));
    state.db.lock().execute_batch("CREATE TRIGGER qa_chat_reject BEFORE INSERT ON agent_attachments WHEN new.name='拒绝.txt' BEGIN SELECT RAISE(ABORT,'reject'); END;").unwrap();
    let first = scratch.create_file("新增.txt", b"first");
    let second = scratch.create_file("拒绝.txt", b"second");
    assert!(batch(vec![file(&first), file(&second)]).unwrap_err().contains("reject"));
    let after = list_session_attachments(&state, &session.id).unwrap();
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].id, saved[0].id);
    let directory = state.data_dir.join("sessions").join(&session.id).join("inputs");
    assert_eq!(fs::read_dir(directory).unwrap().count(), 1);
    assert_snapshot(&state, &session, &original, &after[0]);
}

#[test]
fn chat_explicit_materials_are_session_scoped_and_restored_with_each_message() {
    let scratch = Scratch::new();
    let (state, session) = scratch.setup();
    let a = scratch.create_file("甲.txt", b"A");
    let b = scratch.create_file("乙.txt", b"B");
    let added = import(&state, &session, vec![file(&a), file(&b)]).unwrap();
    let mut request: SendAgentMessageRequest = serde_json::from_value(json!({
        "sessionId": session.id, "content": "只处理乙", "profileId": "p", "model": "m",
        "attachmentIds": [added[1].id]
    })).unwrap();
    let selected = list_turn_attachments(&state, &request).unwrap();
    assert_eq!(selected.len(), 1);
    assert_eq!(selected[0].name, "乙.txt");
    insert_agent_message_with_inputs(&state, &session.id, "user", &request.content, Some("turn"), request.attachment_ids.clone()).unwrap();
    assert_eq!(list_session_messages(&state, &session.id).unwrap()[0].attachment_ids, request.attachment_ids);
    request.attachment_ids = Some(vec![]);
    assert!(list_turn_attachments(&state, &request).unwrap().is_empty());
    request.attachment_ids = Some(vec!["other-session".into()]);
    assert!(list_turn_attachments(&state, &request).is_err());
}

#[test]
fn folder_import_recurses_into_xlsm_and_reports_empty_batches() {
    let scratch = Scratch::new();
    let (state, session) = scratch.setup();
    let csv = scratch.create_file("批次/首表.csv", b"value\n1\n");
    let xlsm = scratch.create_file("批次/子目录/第二表.XLSM", b"synthetic workbook bytes");
    scratch.create_file("批次/子目录/不支持.bin", b"ignored");
    scratch.create_file("批次/子目录/.隐藏.xlsx", b"ignored");
    scratch.create_file("批次/子目录/~$临时.xlsm", b"ignored");
    scratch.create_file("批次/.隐藏目录/看似可读.xlsm", b"ignored");
    scratch.create_file("空批次/.hidden.xlsx", b"ignored");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&xlsm, scratch.0.join("批次/链接.xlsm")).unwrap();

    let added = import(&state, &session, vec![folder(&scratch.0.join("批次"))]).unwrap();
    assert_eq!(added.len(), 2);
    let first = added.iter().find(|item| item.name == "首表.csv").unwrap();
    let second = added.iter().find(|item| item.name == "第二表.XLSM").unwrap();
    let relative = PathBuf::from("子目录").join("第二表.XLSM");
    assert_eq!(second.relative_path.as_deref(), relative.to_str());
    assert_eq!(second.mime_type.as_deref(), Some("application/vnd.ms-excel.sheet.macroEnabled.12"));
    assert_eq!(first.source_group_id, second.source_group_id);
    assert_eq!(second.source_group_name.as_deref(), Some("批次"));
    assert_snapshot(&state, &session, &csv, first);
    assert_snapshot(&state, &session, &xlsm, second);

    assert!(import(&state, &session, vec![folder(&scratch.0.join("空批次"))]).unwrap().is_empty());
    assert!(import(&state, &session, vec![folder(&scratch.0.join("批次"))]).unwrap().is_empty());
    assert_eq!(list_session_attachments(&state, &session.id).unwrap().len(), 2);
}

#[test]
fn duplicate_import_preserves_snapshot_identity_and_design_role() {
    let scratch = Scratch::new();
    let (state, session) = scratch.setup();
    let sample = scratch.create_file("批次/输入.csv", b"value\n1\n");
    let first = import(&state, &session, vec![file(&sample), file(&sample)]).unwrap();
    assert_eq!(first.len(), 1);
    let attachment = &first[0];
    let state_to_save = serde_json::from_value(json!({
        "designId": "import-role-qa",
        "messages": [],
        "attachmentRoles": {attachment.id.clone(): "reference"},
        "parameters": {"column": "value"}
    })).unwrap();
    save_design_state_inner(&state, &session.id, state_to_save).unwrap();

    let same_content = scratch.create_file("移用副本/输入.csv", b"value\n1\n");
    assert!(import(&state, &session, vec![file(&same_content)]).unwrap().is_empty());
    let restored = get_design_state_inner(&state, &session.id).unwrap().unwrap();
    assert_eq!(restored.attachment_roles.get(&attachment.id).map(String::as_str), Some("reference"));
    assert_eq!(restored.parameters, json!({"column": "value"}));
    let attachments = list_session_attachments(&state, &session.id).unwrap();
    assert_eq!(attachments.len(), 1);
    assert_eq!(attachments[0].id, attachment.id);
    assert_snapshot(&state, &session, &sample, &attachments[0]);

    let changed_content = scratch.create_file("修改副本/输入.csv", b"value\n2\n");
    let changed = import(&state, &session, vec![file(&changed_content)]).unwrap();
    assert_eq!(changed.len(), 1);
    assert_ne!(changed[0].id, attachment.id);
    assert_snapshot(&state, &session, &changed_content, &changed[0]);
}

#[test]
fn failing_batch_leaves_earlier_imports_and_discards_new_snapshots() {
    let scratch = Scratch::new();
    let (state, session) = scratch.setup();
    let retained = scratch.create_file("保留.csv", b"value\n1\n");
    let original = import(&state, &session, vec![file(&retained)]).unwrap().remove(0);
    let accepted_first = scratch.create_file("先处理.csv", b"value\n2\n");
    let rejected_second = scratch.create_file("写库失败.csv", b"value\n3\n");
    state.db.lock().execute_batch(
        "CREATE TRIGGER qa_reject_attachment BEFORE INSERT ON agent_attachments
         WHEN new.name='写库失败.csv' BEGIN SELECT RAISE(ABORT,'synthetic insert failure'); END;",
    ).unwrap();

    let error = import(&state, &session, vec![file(&accepted_first), file(&rejected_second)]).unwrap_err();
    assert!(error.contains("synthetic insert failure"), "{error}");
    let attachments = list_session_attachments(&state, &session.id).unwrap();
    assert_eq!(attachments.len(), 1);
    assert_eq!(attachments[0].id, original.id);
    assert_snapshot(&state, &session, &retained, &attachments[0]);
    let snapshot_dir = state.data_dir.join("sessions").join(&session.id).join("inputs");
    assert_eq!(fs::read_dir(snapshot_dir).unwrap().count(), 1);
    assert_eq!(fs::read(accepted_first).unwrap(), b"value\n2\n");
    assert_eq!(fs::read(rejected_second).unwrap(), b"value\n3\n");
}

#[cfg(unix)]
#[test]
fn unreadable_child_rolls_back_mixed_batch_and_preserves_the_existing_design() {
    use std::os::unix::fs::PermissionsExt;

    let scratch = Scratch::new();
    let (state, session) = scratch.setup();
    let retained = scratch.create_file("旧材料.csv", b"value\n1\n");
    let retained_snapshot = import(&state, &session, vec![file(&retained)]).unwrap().remove(0);
    let existing_design = save_design_state_inner(&state, &session.id, serde_json::from_value(json!({
        "designId": "permission-recovery-qa",
        "messages": [{"role":"user","content":"旧设计规则"}],
        "attachmentRoles": {retained_snapshot.id.clone(): "reference"},
        "parameters": {"column": "value"},
        "testResult": {"status":"passed","summary":"旧测试通过","outputs":[],"parameters":{},"repairable":false}
    })).unwrap()).unwrap();
    state.db.lock().execute(
        "UPDATE agent_sessions SET codex_thread_id = ?2 WHERE id = ?1",
        params![session.id, "synthetic-prior-thread"],
    ).unwrap();
    let prior_session = serde_json::to_value(load_agent_session(&state, &session.id).unwrap()).unwrap();

    let first = scratch.create_file("先处理.csv", b"value\n2\n");
    let visible = scratch.create_file("待导入/可读.csv", b"value\n3\n");
    let denied = scratch.create_file("待导入/拒绝读取/限制.csv", b"value\n4\n");
    let restricted = denied.parent().unwrap();
    let saved_permissions = fs::metadata(restricted).unwrap().permissions();
    fs::set_permissions(restricted, fs::Permissions::from_mode(0)).unwrap();
    if fs::read_dir(restricted).is_ok() {
        fs::set_permissions(restricted, saved_permissions).unwrap();
        eprintln!("permission test skipped: this user can read a directory with mode 000");
        return;
    }
    let result = import(&state, &session, vec![file(&first), folder(&scratch.0.join("待导入"))]);
    fs::set_permissions(restricted, saved_permissions).unwrap();

    let error = result.unwrap_err();
    assert!(error.contains("请检查读取权限后重试") && error.contains("拒绝读取"), "{error}");
    let attachments = list_session_attachments(&state, &session.id).unwrap();
    assert_eq!(attachments.len(), 1);
    assert_eq!(attachments[0].id, retained_snapshot.id);
    assert_snapshot(&state, &session, &retained, &attachments[0]);
    let snapshot_dir = state.data_dir.join("sessions").join(&session.id).join("inputs");
    assert_eq!(fs::read_dir(snapshot_dir).unwrap().count(), 1);
    let reopened = get_design_state_inner(&state, &session.id).unwrap().unwrap();
    assert_eq!(serde_json::to_value(reopened).unwrap(), serde_json::to_value(existing_design).unwrap());
    assert_eq!(serde_json::to_value(load_agent_session(&state, &session.id).unwrap()).unwrap(), prior_session);
    let persisted_thread: Option<String> = state.db.lock().query_row(
        "SELECT codex_thread_id FROM agent_sessions WHERE id = ?1",
        params![session.id],
        |row| row.get(0),
    ).unwrap();
    assert_eq!(persisted_thread.as_deref(), Some("synthetic-prior-thread"));
    assert_eq!(fs::read(&first).unwrap(), b"value\n2\n");
    assert_eq!(fs::read(&visible).unwrap(), b"value\n3\n");
    assert_eq!(fs::read(&denied).unwrap(), b"value\n4\n");

    let recovered = import(&state, &session, vec![file(&first), folder(&scratch.0.join("待导入"))]).unwrap();
    assert_eq!(recovered.len(), 3);
    assert_eq!(list_session_attachments(&state, &session.id).unwrap().len(), 4);
}
