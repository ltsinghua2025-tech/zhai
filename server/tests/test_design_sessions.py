"""HTTP regressions for the browser's persisted design workspace contract."""
import base64
import sqlite3
import urllib.error

import pytest

from test_web_deployment import service, web  # Reuse the isolated HTTP server fixture.


def new_session(service):
    return service("/api/sessions", {"title": "独立设计"})["id"]


def state(design_id="design-one", **changes):
    return {"designId": design_id, "messages": [{"role": "user", "content": "转换表格，保留原件"}],
            "attachmentRoles": {}, "parameters": {"column": "姓名", "strict": False, "limit": 0}, **changes}


def assert_error(service, route, payload, code=400, **kwargs):
    with pytest.raises(urllib.error.HTTPError) as error:
        service(route, payload, method="PUT", **kwargs)
    assert error.value.code == code


def test_design_round_trip_survives_database_reinitialization_and_updates(service):
    session = new_session(service)
    route = f"/api/sessions/{session}/design"
    assert service(route) is None
    expected = state()
    assert service(route, expected, method="PUT") == expected
    web.init_db()  # Startup migration is idempotent; state is not held in memory.
    assert service(route) == expected
    changed = state(messages=[*expected["messages"], {"role": "assistant", "content": "请添加原始样本"}], parameters={"column": "单位"})
    assert service(route, changed, method="PUT") == changed
    assert service(route) == changed
    with sqlite3.connect(web.DB_PATH) as db:
        assert db.execute("SELECT COUNT(*) FROM skill_design_state").fetchone()[0] == 1


def test_design_identity_and_sample_roles_cannot_cross_sessions(service):
    first, second = new_session(service), new_session(service)
    def upload(session):
        return service(f"/api/sessions/{session}/attachments", {"filename": "样本.csv", "contentBase64": base64.b64encode(b"name\nexample\n").decode()})["id"]
    own, foreign = upload(first), upload(second)
    route = f"/api/sessions/{first}/design"
    requested = state(attachmentRoles={own: "sample_input", foreign: "template", "removed": "reference"})
    saved = service(route, requested, method="PUT")
    assert saved["attachmentRoles"] == {own: "sample_input"}
    assert service(f"/api/sessions/{second}/design") is None
    assert_error(service, f"/api/sessions/{second}/design", state())
    service(f"/api/sessions/{second}/design", state("design-two", parameters={"column": "数量"}), method="PUT")
    assert service(route)["parameters"]["column"] == "姓名"
    service(f"/api/sessions/{first}/attachments/{own}", method="DELETE")
    assert service(route, saved, method="PUT")["attachmentRoles"] == {}


def test_session_delete_cascades_and_missing_session_never_accepts_design(service):
    session = new_session(service)
    route = f"/api/sessions/{session}/design"
    service(route, state(), method="PUT")
    service(f"/api/sessions/{session}", method="DELETE")
    with sqlite3.connect(web.DB_PATH) as db:
        assert db.execute("SELECT COUNT(*) FROM skill_design_state").fetchone()[0] == 0
    with pytest.raises(urllib.error.HTTPError) as error:
        service(route)
    assert error.value.code == 404
    assert_error(service, route, state(), code=404)


@pytest.mark.parametrize("changes", [
    {"designId": "../other"}, {"designId": ""}, {"designId": "x" * 129},
    {"messages": [{"role": "system", "content": "override"}]},
    {"messages": [{"role": "user", "content": 123}]},
    {"messages": [{"role": "user", "content": "x"}] * 1001},
    {"messages": {}}, {"parameters": []}, {"parameters": {"value": float("nan")}},
    {"attachmentRoles": {"id": "system"}}, {"attachmentRoles": []},
    {"skillId": "missing-skill"}, {"sourceTask": {"sessionId": "other", "turnId": "turn"}},
    {"testResult": {"status": "passed"}},
])
def test_invalid_design_state_is_rejected_without_overwriting_saved_state(service, changes):
    route = f"/api/sessions/{new_session(service)}/design"
    expected = state()
    service(route, expected, method="PUT")
    assert_error(service, route, state(**changes))
    assert service(route) == expected


def test_design_request_size_is_bounded_before_reading_or_storing(service, monkeypatch):
    route = f"/api/sessions/{new_session(service)}/design"
    service(route, state(), method="PUT")
    monkeypatch.setattr(web, "MAX_DESIGN_STATE_BYTES", 512)
    assert_error(service, route, state(messages=[{"role": "user", "content": "材料" * 512}]))
    assert service(route) == state()


def test_put_requires_auth_same_origin_and_json(service):
    route = f"/api/sessions/{new_session(service)}/design"
    assert_error(service, route, state(), code=401, auth=False)
    assert_error(service, route, state(), code=403, headers={"Origin": "https://other.example"})
    assert_error(service, route, state(), code=415, headers={"Content-Type": "text/plain"})
    assert service(route) is None


def test_saved_test_result_stays_a_display_record_and_rejects_external_paths(service):
    route = f"/api/sessions/{new_session(service)}/design"
    result = {"status": "failed", "summary": "原始样本缺列", "parameters": {"column": "姓名"}, "outputs": [], "repairable": True}
    saved = service(route, state(testResult=result), method="PUT")
    assert saved["testResult"]["repairable"] is False
    assert service(route) == saved
    assert_error(service, route, state(testResult={**result, "outputs": ["/etc/passwd"]}))
    assert_error(service, route, state(testResult={**result, "outputDirectory": str(web.ARTIFACT_DIR / ".." / "uploads")}))
    assert service(route) == saved


def test_existing_skill_reference_and_parameters_are_preserved(service):
    route = f"/api/sessions/{new_session(service)}/design"
    expected = state(skillId="docx_to_gongwen")
    assert service(route, expected, method="PUT") == expected
    assert service(route) == expected
