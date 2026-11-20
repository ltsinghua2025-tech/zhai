import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import urllib.error
import urllib.request
from unittest.mock import patch

import pytest
from docx import Document
from openpyxl import Workbook, load_workbook

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))
import app as web
from runtime_config import model_settings


@pytest.fixture
def service(tmp_path, monkeypatch):
    monkeypatch.setenv("ZHAI_ACCESS_USER", "zhai")
    monkeypatch.setenv("ZHAI_ACCESS_PASSWORD", "test-password")
    monkeypatch.setenv("ZHAI_LLM_API_KEY", "test-server-secret")
    monkeypatch.setenv("ZHAI_LLM_BASE_URL", "https://ai.ctaigw.cn/v1")
    monkeypatch.setattr(web, "DATA_DIR", tmp_path)
    monkeypatch.setattr(web, "UPLOAD_DIR", tmp_path / "uploads")
    monkeypatch.setattr(web, "ARTIFACT_DIR", tmp_path / "artifacts")
    monkeypatch.setattr(web, "DB_PATH", tmp_path / "zhai.sqlite3")
    web.TURNS.clear()
    web.init_db()
    server = web.ThreadingHTTPServer(("127.0.0.1", 0), web.Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"

    def call(path, payload=None, auth=True, method=None, headers=None):
        values = {"Content-Type": "application/json"}
        if auth:
            values["Authorization"] = "Basic " + base64.b64encode(b"zhai:test-password").decode()
        values.update(headers or {})
        request = urllib.request.Request(base + path, data=json.dumps(payload).encode() if payload is not None else None, headers=values, method=method)
        with urllib.request.urlopen(request, timeout=10) as response:
            raw = response.read()
            return json.loads(raw) if response.headers.get_content_type() == "application/json" else raw

    yield call
    for state in web.TURNS.values():
        deadline = time.monotonic() + 10
        while not state.get("finished") and time.monotonic() < deadline:
            time.sleep(.02)
    server.shutdown()
    server.server_close()


def docx_bytes():
    document = Document()
    document.add_paragraph("关于开展测试工作的通知")
    document.add_paragraph("这是合成测试材料。原始文字。")
    out = io.BytesIO()
    document.save(out)
    return out.getvalue()


def test_centered_pages_design_and_promote_replay(service, tmp_path, monkeypatch):
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml.ns import qn
    from runtime_config import JudgeAccess
    from urllib.parse import urlencode

    monkeypatch.setenv("ZHAI_JUDGE_MODE", "1")
    judge = JudgeAccess(tmp_path)
    monkeypatch.setattr(web, "JUDGE", judge)
    def client():
        _, cookie = judge.browser("")
        return lambda route, payload=None: service(route, payload, auth=False, headers={"Cookie": cookie.split(";", 1)[0]})
    visit, stranger = client(), client()
    def upload(sid, filename, title):
        document = Document()
        document.add_paragraph(title)
        document.sections[0].footer.paragraphs[0].text = "既有页脚"
        sample = io.BytesIO()
        document.save(sample)
        result = visit(f"/api/sessions/{sid}/attachments", {"filename": filename, "contentBase64": base64.b64encode(sample.getvalue()).decode()})
        return result, sample.getvalue()
    def check_output(path, title):
        output = Document(io.BytesIO(visit("/api/artifacts/download?" + urlencode({"path": path}))))
        assert [p.text for p in output.paragraphs] == [title]
        footer = output.sections[0].footer
        assert footer.paragraphs[0].text == "既有页脚"
        assert len(footer._element.xpath('.//w:fldSimple')) == 1
        field = footer.paragraphs[-1]._p.xpath('./w:fldSimple')[0]
        assert field.get(qn("w:instr")).strip() == "PAGE"
        assert footer.paragraphs[-1].alignment == WD_ALIGN_PARAGRAPH.CENTER

    sid = visit("/api/sessions", {})["id"]
    sample, original = upload(sid, "样本.docx", "第一页")
    upload(sid, "另一个.docx", "不在本轮")
    direct = visit("/api/skills/design", {"prompt": "设计一个给文件加上居中的页码的技能"})
    assert [step["toolId"] for step in direct["steps"]] == ["center_docx_page_numbers"]
    # Legacy/model drafts can incorrectly expose a runtime attachment selector as a required user field.
    direct["parameters"] = [{"key": "attachmentIds", "required": True, "type": "array"}]
    direct["steps"][0]["parameters"]["attachmentIds"] = {"$param": "attachmentIds"}
    skill = visit("/api/skills", {"tool": direct})
    assert skill["parameters"] == [] and skill["steps"][0]["parameters"] == {}
    tested = visit(f"/api/skills/{skill['id']}/test", {"files": [{"attachmentId": sample["id"]}]})
    check_output(tested["testResult"]["outputs"][0], "第一页")
    run = visit(f"/api/sessions/{sid}/messages", {"content": "给文件加上居中的页码", "attachmentIds": [sample["id"]]})
    for _ in range(200):
        state = visit("/api/turns/" + run["turnId"])
        if state["status"] != "running":
            break
        time.sleep(.025)
    assert state["status"] == "completed" and state["detail"]["messages"][-1]["canDesignSkill"]
    route = f"/api/sessions/{sid}/turns/{run['turnId']}/design"
    with pytest.raises(urllib.error.HTTPError) as denied:
        stranger(route, {})
    assert denied.value.code == 404
    design = visit(route, {})["sessionId"]
    assert visit(route, {})["sessionId"] == design
    new_session = visit(f"/api/sessions/{design}")
    assert [a["name"] for a in new_session["attachments"]] == ["样本.docx"]
    assert new_session["attachments"][0]["id"] != sample["id"]
    saved = visit(f"/api/sessions/{design}/design")
    copied_id = saved["skillId"]
    assert saved["sourceTask"]["turnId"] == run["turnId"]
    assert visit("/api/skills/" + copied_id)["steps"] == [{"toolId": "center_docx_page_numbers", "parameters": {}}]
    replacement, _ = upload(design, "换料.docx", "第二份独立文档")
    tested = visit(f"/api/skills/{copied_id}/test", {"files": [{"attachmentId": replacement["id"]}]})
    check_output(tested["testResult"]["outputs"][0], "第二份独立文档")
    assert visit(f"/api/skills/{copied_id}/publish", {})["available"]
    assert Path(sample["localSnapshotPath"]).read_bytes() == original


def test_history_scopes_and_legacy_assistant_end_markers():
    history = {"attachments": ["a", "b"], "messages": [
        {"role": "user", "content": "阅读第一份", "attachmentIds": ["a"]},
        {"role": "assistant", "content": "第一份的原文"},
        {"role": "user", "content": "阅读第二份", "attachmentIds": ["b"]},
    ]}
    assert [m["content"] for m in web.scoped_chat_history(history, True, frozenset(["b"]))] == ["阅读第二份"]
    assert web.scoped_chat_history(history, False, frozenset(["b"])) == []
    marker = "<｜end▁of▁sentence｜>"
    assert web.strip_assistant_end_marker("示例" + marker + "结束。\n" + marker + " " + marker) == "示例" + marker + "结束。"


def test_judge_workspaces_and_background_results(service, tmp_path, monkeypatch):
    from urllib.parse import urlencode
    from runtime_config import JudgeAccess

    monkeypatch.setenv("ZHAI_JUDGE_MODE", "1")
    monkeypatch.setenv("ZHAI_LLM_API_KEY", "")
    judge = JudgeAccess(tmp_path)
    monkeypatch.setattr(web, "JUDGE", judge)
    alice_root, alice_cookie = judge.browser("")
    _, bob_cookie = judge.browser("")
    assert "HttpOnly" in alice_cookie and "; Secure" in alice_cookie
    alice = {"Cookie": alice_cookie.split(";", 1)[0]}
    bob = {"Cookie": bob_cookie.split(";", 1)[0]}
    assert JudgeAccess(tmp_path).browser(alice["Cookie"]) == (alice_root, None)
    assert judge.browser(bob["Cookie"].split(".")[0] + ".invalid")[1] is not None
    sid = service("/api/sessions", {"title": "Alice"}, auth=False, headers=alice)["id"]
    assert service("/api/sessions", auth=False, headers=bob) == []
    with pytest.raises(urllib.error.HTTPError) as denied:
        service(f"/api/sessions/{sid}", auth=False, headers=bob)
    assert denied.value.code == 404
    artifact_input = service(f"/api/sessions/{sid}/attachments", {"filename": "通知.docx",
        "contentBase64": base64.b64encode(docx_bytes()).decode()}, auth=False, headers=alice)
    run = service(f"/api/sessions/{sid}/messages", {"content": "公文排版"}, auth=False, headers=alice)
    turn = "/api/turns/" + run["turnId"]
    with pytest.raises(urllib.error.HTTPError) as denied:
        service(turn, auth=False, headers=bob)
    assert denied.value.code == 404
    for _ in range(200):
        result = service(turn, auth=False, headers=alice)
        if result["status"] != "running":
            break
        time.sleep(.03)
    assert result["status"] == "completed", result
    artifact = next(row for row in result["detail"]["attachments"] if row["kind"] == "artifact")
    download = "/api/artifacts/download?" + urlencode({"path": artifact["localSnapshotPath"]})
    assert Document(io.BytesIO(service(download, auth=False, headers=alice))).paragraphs
    with pytest.raises(urllib.error.HTTPError):
        service(download, auth=False, headers=bob)
    draft = {"id": "sample", "name": "排版", "steps": [{"toolId": "docx_to_gongwen"}], "supportedExtensions": ["docx"]}
    for visitor in (alice, bob):
        service("/api/skills", {"tool": draft}, auth=False, headers=visitor)
    files = {"files": [{"attachmentId": artifact_input["id"]}]}
    assert service("/api/skills/sample/test", files, auth=False, headers=alice)["testStatus"] == "passed"
    assert service("/api/skills/sample/test", files, auth=False, headers=bob)["testStatus"] == "failed"
    service("/api/skills/sample/publish", {}, auth=False, headers=alice)
    assert not service("/api/skills/sample", auth=False, headers=bob)["available"]
    assert service("/api/profiles", auth=False, headers=alice)[0]["managed"]
    assert not service("/api/profiles", auth=False, headers=alice)[0]["keyStored"]
    with pytest.raises(ValueError, match="评委版使用部署方"):
        model_settings({"baseUrl": "https://example.invalid/v1", "apiKey": "my-key"})
    from data_admin import backup, restore
    archive = tmp_path.with_suffix(".zip")
    restored = tmp_path.with_name(tmp_path.name + "-restored")
    backup(tmp_path, archive)
    restore(archive, restored)
    restored_alice, rotated = JudgeAccess(restored).browser(alice["Cookie"])
    assert rotated is None
    with sqlite3.connect(restored_alice / "zhai.sqlite3") as db:
        paths = [Path(r[0]) for r in db.execute("SELECT server_path FROM attachments")]
    assert len(paths) == 2 and all(p.is_relative_to(restored_alice) and p.is_file() for p in paths)


def test_shared_model_budget_counts_visitors_and_concurrent_calls(tmp_path):
    from contextlib import ExitStack
    from runtime_config import JudgeAccess
    judge = JudgeAccess(tmp_path)
    with ExitStack() as active:
        for i in range(4):
            active.enter_context(judge.model_request(tmp_path / str(i)))
        with pytest.raises(ValueError, match="请求较多"), judge.model_request(tmp_path / "fifth"):
            pass
    for _ in range(20):
        with judge.model_request(tmp_path / "budget"):
            pass
    with pytest.raises(ValueError, match="请求较多"), judge.model_request(tmp_path / "budget"):
        pass


def test_web_release_contract_matches_downloaded_pdf_text(service, tmp_path):
    from reportlab.pdfgen.canvas import Canvas
    assert service("/api/health", auth=False)["version"] == web.WEB_VERSION
    tools = {item["id"]: item for item in service("/api/tools")}
    assert tools["extract_pdf_text"]["outputFormats"] == ["txt"]
    assert all("csv" not in item["supportedExtensions"] for item in tools.values())
    assert tools["normalize_docx_styles"]["supportedExtensions"] == ["docx"]
    assert "pdf" not in tools["redact_content"]["supportedExtensions"]
    source = tmp_path / "text.pdf"
    canvas = Canvas(str(source))
    canvas.drawString(50, 700, "Sealos 0.27.1 output contract")
    canvas.save()
    original = source.read_bytes()
    result = service("/api/skills/run", {
        "skillId": "extract_pdf_text", "files": [{
            "filename": source.name, "contentBase64": base64.b64encode(original).decode(),
        }],
    })
    assert len(result["artifacts"]) == 1
    artifact = result["artifacts"][0]
    assert artifact["name"].endswith(".txt")
    from urllib.parse import urlencode
    content = service("/api/artifacts/download?" + urlencode({"path": artifact["localSnapshotPath"]}))
    assert b"Sealos 0.27.1 output contract" in content
    assert source.read_bytes() == original


@pytest.mark.parametrize("filename", [
    "汇总%20终稿.txt", "汇总%2F终稿.txt", "汇总%25终稿.txt", "中文 空格+加号#1.txt",
])
def test_artifact_download_preserves_literal_url_characters(service, filename):
    from urllib.parse import unquote, urlencode

    target = web.ARTIFACT_DIR / filename
    expected = "这是选中的成果，不能返回另一份文件。".encode()
    target.write_bytes(expected)
    decoded = web.ARTIFACT_DIR / unquote(filename)
    if decoded != target:
        decoded.parent.mkdir(parents=True, exist_ok=True)
        decoded.write_bytes(b"different artifact")
    before = web.file_hash(target)
    downloaded = service("/api/artifacts/download?" + urlencode({"path": str(target)}))
    assert downloaded == expected
    assert web.file_hash(target) == before


def test_artifact_directory_download_preserves_literal_percent(service):
    from urllib.parse import urlencode
    from zipfile import ZipFile

    target = web.ARTIFACT_DIR / "成果%20文件夹"
    target.mkdir()
    (target / "核验.txt").write_text("正确成果", encoding="utf-8")
    decoy = web.ARTIFACT_DIR / "成果 文件夹"
    decoy.mkdir()
    (decoy / "核验.txt").write_text("另一份成果", encoding="utf-8")
    downloaded = service("/api/artifacts/download?" + urlencode({"path": str(target)}))
    with ZipFile(io.BytesIO(downloaded)) as archive:
        assert archive.namelist() == ["核验.txt"]
        assert archive.read("核验.txt").decode() == "正确成果"


def test_artifact_download_still_rejects_paths_outside_artifacts(service, tmp_path):
    from urllib.parse import urlencode

    outside = tmp_path / "outside.txt"
    outside.write_text("not an artifact", encoding="utf-8")
    for target in (outside, web.ARTIFACT_DIR / ".." / outside.name, web.ARTIFACT_DIR):
        with pytest.raises(urllib.error.HTTPError) as error:
            service("/api/artifacts/download?" + urlencode({"path": str(target)}))
        assert error.value.code == 400


def upload(call, session, name, raw):
    return call(f"/api/sessions/{session}/attachments", {"filename": name, "contentBase64": base64.b64encode(raw).decode()})


def wait_turn(call, turn):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        state = call(f"/api/turns/{turn}")
        if state["status"] != "running":
            return state
        time.sleep(.02)
    raise AssertionError("turn timeout")


def test_auth_and_key_confinement(service):
    assert service("/api/health", auth=False)["ok"]
    for route in ("/", "/api/sessions", "/api/profiles", "/api/artifacts/download?path=/etc/passwd"):
        with pytest.raises(urllib.error.HTTPError) as error:
            service(route, auth=False)
        assert error.value.code == 401
    profiles = service("/api/profiles")
    assert profiles[0]["keyStored"]
    assert "test-server-secret" not in json.dumps(profiles)
    with pytest.raises(ValueError, match="自定义接口"):
        model_settings({"baseUrl": "https://other.example/v1"})
    assert model_settings({"baseUrl": "https://other.example/v1", "apiKey": "my-key"})[1] == "my-key"
    with pytest.raises(urllib.error.HTTPError) as error:
        service("/api/sessions", {}, headers={"Origin": "https://other.example"})
    assert error.value.code == 403


def test_word_round_trip_and_original_hash(service):
    session = service("/api/sessions", {})["id"]
    attachment = upload(service, session, "测试.docx", docx_bytes())
    digest = web.file_hash(Path(attachment["localSnapshotPath"]))
    result, artifacts = web.run_session_tool(session, "docx_to_gongwen", {})
    assert result["completedFiles"] == 1
    assert len(artifacts) == 1 and artifacts[0]["name"].endswith(".docx")
    from urllib.parse import urlencode
    downloaded = service("/api/artifacts/download?" + urlencode({"path": artifacts[0]["localSnapshotPath"]}))
    assert "原始文字" in "".join(p.text for p in Document(io.BytesIO(downloaded)).paragraphs)
    assert web.file_hash(Path(attachment["localSnapshotPath"])) == digest


def test_profiles_only_accept_supported_interfaces(service):
    for provider in ("openai", "anthropic", "gemini"):
        with pytest.raises(urllib.error.HTTPError) as error:
            service("/api/profiles", {"provider": provider})
        assert error.value.code == 400
    for provider in ("deepseek", "openai_compatible"):
        profile = service("/api/profiles", {"provider": provider})
        assert profile["provider"] == provider
        assert "test-server-secret" not in json.dumps(profile)


def test_xlsx_header_merge(service):
    session = service("/api/sessions", {})["id"]
    for index, rows in enumerate([[["姓名", "数量"], ["甲", 3]], [["数量", "姓名"], [5, "乙"]]]):
        workbook = Workbook()
        for row in rows:
            workbook.active.append(row)
        out = io.BytesIO()
        workbook.save(out)
        upload(service, session, f"表{index}.xlsx", out.getvalue())
    result, artifacts = web.run_session_tool(session, "merge_xlsx", {})
    assert len(artifacts) == 1
    workbook = load_workbook(artifacts[0]["localSnapshotPath"])
    rows = list(workbook.active.values)
    name_index, number_index = rows[0].index("姓名"), rows[0].index("数量")
    assert (rows[1][name_index], rows[1][number_index]) == ("甲", 3)
    assert (rows[2][name_index], rows[2][number_index]) == ("乙", 5)
    assert "表0.xlsx" in rows[1] and "表1.xlsx" in rows[2]
    workbook.close()


def test_skill_form_parameters_reach_test_and_run(service):
    builtin = web.find_skill("docx_to_gongwen")
    skill = {**builtin, "id": "parameter-form-check", "name": "参数检查", "source": "designed", "status": "draft", "testStatus": "untested", "available": False}
    web.save_skill(skill)
    payload = {"files": [{"filename": "测试.docx", "contentBase64": base64.b64encode(docx_bytes()).decode()}], "parameters": {"addTitleBlankLine": True, "formatTables": False}}
    with patch.object(web, "run_skill_engine", wraps=web.run_skill_engine) as run:
        assert service("/api/skills/parameter-form-check/test", payload)["testStatus"] == "passed"
        assert run.call_args.args[3] == payload["parameters"]
        service("/api/skills/parameter-form-check/publish", {})
        service("/api/skills/run", {**payload, "skillId": "parameter-form-check"})
        assert run.call_args.args[3] == payload["parameters"]


def test_background_tools_reasoning_and_polling(service):
    session = service("/api/sessions", {})["id"]
    upload(service, session, "测试.docx", docx_bytes())
    with sqlite3.connect(web.DB_PATH) as db:
        db.execute("INSERT INTO messages VALUES (?, ?, 'assistant', ?, ?, ?)", ("old-answer", session, "旧轮引用的附件正文不应再次发出", web.now(), "old-turn"))
    calls = []

    def model(url, key, model, messages, **kwargs):
        assert "旧轮引用的附件正文" not in json.dumps(messages, ensure_ascii=False)
        calls.append(messages.copy())
        if len(calls) == 1:
            return {"choices": [{"message": {"role": "assistant", "reasoning_content": "保留推理字段", "content": "", "tool_calls": [{"id": "call-1", "type": "function", "function": {"name": "docx_to_gongwen", "arguments": "{}"}}]}}]}
        assert messages[-2]["reasoning_content"] == "保留推理字段"
        assert not any(a["kind"] == "artifact" for a in web.get_session(session)["attachments"])
        return {"choices": [{"message": {"content": "处理完成"}}]}

    with patch.object(web, "call_openai_compatible_payload", side_effect=model):
        started = service(f"/api/sessions/{session}/messages", {"content": "公文排版"})
        state = wait_turn(service, started["turnId"])
    assert state["status"] == "completed", state
    artifacts = [item for item in state["detail"]["attachments"] if item["kind"] == "artifact"]
    assert len(artifacts) == 1
    assert '处理说明' in state['detail']['messages'][-1]['content']
    assert '实际分页' in state['detail']['messages'][-1]['content']
    assert service(f"/api/turns/{started['turnId']}?offset={state['offset']}")["events"] == []


def test_cancellation_keeps_busy_and_discards_outputs(service):
    session = service("/api/sessions", {})["id"]
    entered, release = threading.Event(), threading.Event()

    def slow(*args, **kwargs):
        entered.set()
        release.wait(5)
        return {"choices": [{"message": {"content": "结束"}}]}

    with patch.object(web, "call_openai_compatible_payload", side_effect=slow):
        started = service(f"/api/sessions/{session}/messages", {"content": "测试"})
        assert entered.wait(2)
        service(f"/api/sessions/{session}/cancel", {})
        with pytest.raises(ValueError, match="一次处理一个"):
            web.start_background_turn(session, "另一轮", {})
        release.set()
        state = wait_turn(service, started["turnId"])
    assert state["status"] == "cancelled"
    assert not state["detail"]["attachments"]


@pytest.mark.parametrize("action", ["cancel", "timeout", "design_cancel"])
def test_blocked_model_socket_is_released(service, monkeypatch, action):
    accepted, closed = threading.Event(), threading.Event()

    class SilentModel(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            accepted.set()
            self.connection.settimeout(10)
            if self.connection.recv(1) == b"":
                closed.set()

    server = ThreadingHTTPServer(("127.0.0.1", 0), SilentModel)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    settings = (f"http://127.0.0.1:{server.server_port}/v1", "synthetic", "local")
    monkeypatch.setattr(web, "model_settings", lambda payload: settings)
    if action == "timeout":
        monkeypatch.setattr(web, "TURN_TIMEOUT_SECONDS", 4)
    try:
        if action == "design_cancel":
            from concurrent.futures import ThreadPoolExecutor
            with ThreadPoolExecutor(1) as pool:
                request = pool.submit(service, "/api/skills/design", {"prompt": "设计一个表格工作流", "runId": "silent-model-design"})
                assert accepted.wait(5)
                service("/api/design-runs/silent-model-design/cancel", {})
                with pytest.raises(urllib.error.HTTPError) as stopped:
                    request.result(timeout=3)
                assert stopped.value.code == 409
        else:
            session = service("/api/sessions", {})["id"]
            started = service(f"/api/sessions/{session}/messages", {"content": "测试总时限"})
            assert accepted.wait(5)
            if action == "cancel":
                service(f"/api/sessions/{session}/cancel", {})
            state = wait_turn(service, started["turnId"])
            assert state["status"] == ("cancelled" if action == "cancel" else "failed")
            assert state["detail"]["session"]["title"] == "测试总时限"
            assert [item["role"] for item in state["detail"]["messages"]] == ["user"]
        assert closed.wait(2)
    finally:
        server.shutdown()
        server.server_close()


def test_early_design_cancel_blocks_save_and_sample_test(service):
    run_id = "cancel-before-request"
    tool = {"id": "cancelled-design", "name": "已停止的设计", "steps": [{"toolId": "docx_to_gongwen"}]}
    service("/api/skills", {"tool": tool})
    assert service(f"/api/design-runs/{run_id}/cancel", {})["status"] == "stopping"
    for route, data in [
        ("/api/skills/design", {"prompt": "提取PDF中的文字"}),
        ("/api/skills", {"tool": {**tool, "name": "不应覆盖"}}),
        ("/api/skills/cancelled-design/test", {"files": []}),
    ]:
        with pytest.raises(urllib.error.HTTPError) as error:
            service(route, {**data, "designRunId": run_id})
        assert error.value.code == 409
    stored = service("/api/skills/cancelled-design")
    assert stored["name"] == tool["name"] and stored["testStatus"] == "untested"


def test_pdf_design_uses_compatible_tool_for_sample(service):
    sample = [{"path": "/uploaded/input.pdf", "role": "sample_input"}]
    with patch.object(web, "call_openai_compatible") as model:
        draft = service("/api/skills/design", {"prompt": "请提取 PDF 中的文字", "attachments": sample})
        model.assert_not_called()
        assert draft["supportedExtensions"] == ["pdf"]
        assert draft["steps"] == [{"toolId": "extract_pdf_text", "parameters": {}}]
        model.return_value = json.dumps({"steps": [{"toolId": "redact_content", "parameters": {}}]})
        with pytest.raises(urllib.error.HTTPError) as incompatible:
            service("/api/skills/design", {"prompt": "请按样本处理", "attachments": sample})
        assert "不兼容" in json.loads(incompatible.value.read())["error"]


def test_upload_retry_keeps_identity_for_same_material(service):
    session = service("/api/sessions", {})["id"]
    route = f"/api/sessions/{session}/attachments"
    data = {"filename": "同名.txt", "contentBase64": "YQ=="}
    first = service(route, data)["id"]
    assert service(route, data)["id"] == first
    assert service(route, {**data, "contentBase64": "Yg=="})["id"] != first
    folder = {**data, "kind": "folder", "groupId": "folder-a", "relativePath": "子目录/同名.txt"}
    grouped = service(route, folder)["id"]
    assert service(route, folder)["id"] == grouped
    assert service(route, {**folder, "groupId": "folder-b"})["id"] != grouped
    assert len(service(f"/api/sessions/{session}")["attachments"]) == 4


def test_failed_output_not_published_and_skill_test_reset(service):
    session = service("/api/sessions", {})["id"]
    upload(service, session, "坏文件.docx", b"broken")
    with pytest.raises(RuntimeError):
        web.run_session_tool(session, "docx_to_gongwen", {})
    assert not any(a["kind"] == "artifact" for a in web.get_session(session)["attachments"])
    result = service("/api/skills", {"tool": {"id": "test-skill", "name": "测试", "testStatus": "passed", "available": True, "status": "published"}})
    assert result["testStatus"] == "untested" and not result["available"]


def test_backup_restore_relocates_and_protects_data(service, tmp_path):
    from data_admin import backup, restore, data_lock
    session = service('/api/sessions', {})['id']
    original = docx_bytes()
    upload(service, session, '测试.docx', original)
    archive = tmp_path.parent / (tmp_path.name + '.zip')
    with data_lock(tmp_path):
        with pytest.raises(RuntimeError, match='已有服务'):
            backup(tmp_path, archive)
    assert not archive.exists()
    backup(tmp_path, archive)
    target = tmp_path.parent / (tmp_path.name + '-restored')
    restore(archive, target)
    with sqlite3.connect(target / 'zhai.sqlite3') as db:
        path = db.execute('SELECT server_path FROM attachments').fetchone()[0]
    assert str(target) in path and Path(path).read_bytes() == original
    with pytest.raises(ValueError, match='空数据目录'):
        restore(archive, target)
    assert Path(path).read_bytes() == original


@pytest.mark.parametrize('name', ['../escape', '.service.lock', '/absolute'])
def test_restore_rejects_unsafe_paths(tmp_path, name):
    import zipfile
    import hashlib
    from data_admin import restore
    archive = tmp_path / 'bad.zip'
    with zipfile.ZipFile(archive, 'w') as z:
        z.writestr('backup.json', json.dumps({'format': 1, 'source': '/old', 'files': {name: hashlib.sha256(b'x').hexdigest()}}))
        z.writestr('data/' + name, b'x')
    with pytest.raises(ValueError, match='路径无效'):
        restore(archive, tmp_path / 'new')
    assert not (tmp_path / 'escape').exists()
