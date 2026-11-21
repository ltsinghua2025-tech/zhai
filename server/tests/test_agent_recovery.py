import base64
import io
import json
from urllib.parse import urlencode
from unittest.mock import patch

from openpyxl import Workbook, load_workbook

from test_web_deployment import service, upload, wait_turn, web


def book():
    workbook = Workbook()
    workbook.active.title = "Data"
    workbook.active.append(["标题", "内容"])
    workbook.active.append(["甲", "保密正文样例"])
    stream = io.BytesIO()
    workbook.save(stream)
    return stream.getvalue()


def cell(sheet="Data", value="完成"):
    return {"toolId": "set_xlsx_cell", "parameters": {"sheet": sheet, "cell": "B2", "value": value}}


def save(service, steps, fields=None):
    return service("/api/skills", {"tool": {"id": "recover-workbook", "name": "更新后汇总",
                   "steps": steps, "supportedExtensions": ["xlsx"], "parameters": fields or []}})


def payload():
    return {"files": [{"filename": "原始.xlsx", "contentBase64": base64.b64encode(book()).decode()}],
            "repair": {"prompt": "照原要求修复"}}


def test_structural_feedback_recovers_wrong_sheet_and_refuses_fabricated_delivery(service):
    sid = service("/api/sessions", {})["id"]
    source = upload(service, sid, "待填写.xlsx", book())
    def response(message):
        return {"choices": [{"message": message}]}
    def call(sheet):
        return response({"content": "", "tool_calls": [{"id": sheet, "type": "function",
                        "function": {"name": "set_xlsx_cell", "arguments": json.dumps(cell(sheet)["parameters"])}}]})
    for authorized in [False, True]:
        def model(url, key, model, messages, **kwargs):
            last = messages[-1]
            if last["role"] != "tool":
                return call("data")
            result = json.loads(last["content"])
            if result.get("status") != "failed":
                return response({"content": "已完成"})
            assert "保密正文样例" not in last["content"]
            assert result["structure"][0]["sheetCount"] == 1
            if authorized:
                assert result["structure"][0]["sheetNames"] == ["Data"]
                return call("Data")
            assert "sheetNames" not in last["content"]
            return response({"content": "我已完成任务"})
        with patch.object(web, "call_openai_compatible_payload", side_effect=model):
            started = service(f"/api/sessions/{sid}/messages", {"content": "请填写工作表", "attachmentIds": [source["id"]],
                                                                 "allowModelFileAccess": authorized})
            state = wait_turn(service, started["turnId"])
        assert state["status"] == ("completed" if authorized else "failed")
    detail = service(f"/api/sessions/{sid}")
    artifacts = [x for x in detail["attachments"] if x["kind"] == "artifact"]
    assert len(artifacts) == 1
    raw = service("/api/artifacts/download?" + urlencode({"path": artifacts[0]["localSnapshotPath"]}))
    assert load_workbook(io.BytesIO(raw)).active["B2"].value == "完成"


def test_sample_repair_validates_binding_and_business_values(service):
    save(service, [cell(value={"$param": "填写内容"})], [{"key": "text", "label": "填写内容", "type": "text", "required": True}])
    request = {**payload(), "parameters": {"text": "甲方核对"}}
    route = "/api/skills/recover-workbook/test"
    assert service(route, {k: v for k, v in request.items() if k != "repair"})["testResult"]["repairable"]
    with patch.object(web, "call_openai_compatible", return_value=json.dumps({"steps": [cell(value="不同值")]})):
        assert service(route, request)["testStatus"] == "failed"
    with patch.object(web, "call_openai_compatible", return_value=json.dumps({"steps": [cell(value={"$param": "text"})]})):
        fixed = service(route, request)
    assert fixed["id"] == "recover-workbook" and fixed["testStatus"] == "passed"
    raw = service("/api/artifacts/download?" + urlencode({"path": fixed["testResult"]["outputs"][0]}))
    assert load_workbook(io.BytesIO(raw)).active["B2"].value == "甲方核对"


def test_proactive_inspection_is_scoped_and_omits_sheet_names_without_body_permission(service):
    sid = service("/api/sessions", {})["id"]
    selected = upload(service, sid, "选中.xlsx", book())
    ignored = upload(service, sid, "未选中.xlsx", book())
    def model(url, key, model, messages, **kwargs):
        if messages[-1]["role"] != "tool":
            assert "inspect_file_structure" in [t["function"]["name"] for t in kwargs["tools"]]
            return {"choices": [{"message": {"tool_calls": [{"id": "inspect", "type": "function",
                "function": {"name": "inspect_file_structure", "arguments": "{}"}}]}}]}
        result = json.loads(messages[-1]["content"])
        assert result == {"files": [{"id": selected["id"], "format": "xlsx", "sheetCount": 1}], "totalFiles": 1}
        assert ignored["id"] not in str(messages) and "保密正文样例" not in str(messages)
        return {"choices": [{"message": {"content": "该文件有一个工作表"}}]}
    with patch.object(web, "call_openai_compatible_payload", side_effect=model):
        started = service(f"/api/sessions/{sid}/messages", {"content": "请检查结构", "attachmentIds": [selected["id"]]})
        assert wait_turn(service, started["turnId"])["status"] == "completed"


def test_clarification_retains_session_without_partial_output(service):
    sid = service("/api/sessions", {})["id"]
    source = upload(service, sid, "表格.xlsx", book())
    def model(url, key, model, messages, **kwargs):
        failed = messages[-1]["role"] == "tool"
        name = "clarify_file_task" if failed else "set_xlsx_cell"
        args = {"question": "请确认要写入的工作表名称？"} if failed else cell("未指定表")["parameters"]
        return {"choices": [{"message": {"content": "", "tool_calls": [{"id": name, "type": "function",
                            "function": {"name": name, "arguments": json.dumps(args)}}]}}]}
    with patch.object(web, "call_openai_compatible_payload", side_effect=model):
        started = service(f"/api/sessions/{sid}/messages", {"content": "帮我填表", "attachmentIds": [source["id"]]})
        assert wait_turn(service, started["turnId"])["status"] == "completed"
    detail = service(f"/api/sessions/{sid}")
    assert detail["messages"][-1]["content"].endswith("请确认要写入的工作表名称？")
    assert all(x["kind"] != "artifact" for x in detail["attachments"])


def test_changed_order_is_separate_candidate_after_real_execution(service):
    merge = {"toolId": "merge_xlsx", "parameters": {}}
    write = cell()
    original = save(service, [merge, write])
    request = payload()
    request["files"].append({**request["files"][0], "filename": "第二份.xlsx"})
    with patch.object(web, "call_openai_compatible", return_value=json.dumps({"steps": [write, merge]})):
        candidate = service("/api/skills/recover-workbook/test", request)
    assert candidate["testStatus"] == "passed"
    assert candidate["id"] != original["id"] and candidate["status"] == "draft"
    assert web.find_skill(original["id"])["steps"] == [merge, write]
    raw = service("/api/artifacts/download?" + urlencode({"path": candidate["testResult"]["outputs"][0]}))
    rows = list(load_workbook(io.BytesIO(raw)).active.values)
    assert len(rows) == 3 and all("完成" in row for row in rows[1:])
