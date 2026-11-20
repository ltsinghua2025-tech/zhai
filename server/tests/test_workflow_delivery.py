import base64
import hashlib
import io
import json
from unittest.mock import patch
from urllib.parse import urlencode

from openpyxl import Workbook, load_workbook

from test_web_deployment import service, web


def test_sample_and_run_bind_each_value_and_reopen_final_workbook(service):
    book = Workbook()
    book.active.append(["原甲", "原乙"])
    stream = io.BytesIO()
    book.save(stream)
    original = stream.getvalue()
    original_hash = hashlib.sha256(original).digest()
    fields = [{"key": key, "label": key, "type": "text", "required": True} for key in ("left", "value")]
    steps = [{"toolId": "set_xlsx_cell", "parameters": {"sheet": "Sheet", "cell": cell, "value": value}}
             for cell, value in [("A1", {"$param": "left"}), ("B1", {"$param": "value"})]]
    service("/api/skills", {"tool": {"id": "two-cells", "steps": steps, "parameters": fields,
                                     "name": "双格填写", "supportedExtensions": ["xlsx"]}})
    payload = {"files": [{"filename": "原件.xlsx", "contentBase64": base64.b64encode(original).decode()}]}

    def check_download(paths, expected):
        assert len(paths) == 1
        raw = service("/api/artifacts/download?" + urlencode({"path": paths[0]}))
        book = load_workbook(io.BytesIO(raw))
        try:
            assert list(book.active.values) == [tuple(expected)]
        finally:
            book.close()

    payload["parameters"] = {"left": "样本甲", "value": "样本乙"}
    skill = service("/api/skills/two-cells/test", payload)
    assert skill["testStatus"] == "passed"
    check_download(skill["testResult"]["outputs"], ["样本甲", "样本乙"])
    service("/api/skills/two-cells/publish", {})
    for i in (1, 2):
        values = [f"换值甲{i}", f"换值乙{i}"]
        result = service("/api/skills/run", {**payload, "skillId": "two-cells",
                                             "parameters": dict(zip(("left", "value"), values))})
        check_download([item["localSnapshotPath"] for item in result["artifacts"]], values)
    assert hashlib.sha256(stream.getvalue()).digest() == original_hash


def test_legacy_form_only_overrides_unambiguous_named_operation_field():
    skill = {"source": "designed", "parameters": [{"key": "value", "required": True}],
             "steps": [{"toolId": "set_xlsx_cell", "parameters": {"cell": "A1", "value": "样本默认值"}}]}
    operation, = web.skill_operations(skill, {"value": "正式值"})
    assert operation["parameters"] == {"cell": "A1", "value": "正式值"}


def test_appending_to_design_keeps_id_and_prior_steps(service, monkeypatch):
    monkeypatch.setenv("ZHAI_LLM_API_KEY", "")
    draft = service("/api/skills/design", {"prompt": "公文排版"})
    service("/api/skills", {"tool": draft})
    edited = service("/api/skills/design", {"prompt": "再加上脱敏", "currentSkillId": draft["id"]})
    assert edited["id"] == draft["id"]
    assert [step["toolId"] for step in edited["steps"]] == ["docx_to_gongwen", "redact_content"]
    monkeypatch.setenv("ZHAI_LLM_API_KEY", "synthetic")
    with patch.object(web, "call_openai_compatible", return_value=json.dumps({"steps": edited["steps"][-1:]})) as model:
        ai_edit = service("/api/skills/design", {"prompt": "再加上脱敏", "currentSkillId": draft["id"]})
        assert ai_edit["steps"] == edited["steps"]
        assert draft["name"] in model.call_args.args[3][0]["content"]
