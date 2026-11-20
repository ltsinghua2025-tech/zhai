import io
import os
import time
from pathlib import Path

import pytest

from test_web_deployment import service, web
from data_admin import storage_report


def test_stream_upload_keeps_existing_attachment_identity_and_reports_unlisted_snapshot(service):
    session = service("/api/sessions", {})["id"]
    meta = {"filename": "复用.txt", "kind": "file"}
    payload = b"same content"
    streamed = web.store_upload(io.BytesIO(payload), len(payload), meta, session)
    import base64
    legacy = service(f"/api/sessions/{session}/attachments",
                     {**meta, "contentBase64": base64.b64encode(payload).decode()})
    assert streamed["id"] == legacy["id"]
    assert storage_report(web.DATA_DIR)["unlistedSessionSnapshots"] == 0
    service(f"/api/sessions/{session}", method="DELETE")
    assert storage_report(web.DATA_DIR)["unlistedSessionSnapshotBytes"] == len(payload)


def test_short_upload_cleans_partial_and_expired_token_never_serves_bytes(service):
    with pytest.raises(ValueError, match="传输中断"):
        web.store_upload(io.BytesIO(b"short"), 100, {"filename": "short.xlsx"}, None)
    assert not list(web.uploads_dir().glob(".receiving-*"))
    ref = web.store_upload(io.BytesIO(b"one"), 3, {"filename": "demo.xlsx"}, None)
    saved, = web.materialize_skill_files("run-before-expiry", [ref])
    directory = web.uploads_dir() / ".upload-cache" / ref["uploadId"]
    old = time.time() - web.UPLOAD_CACHE_TTL - 1
    os.utime(directory, (old, old))
    with pytest.raises(ValueError, match="过期"):
        web.materialize_skill_files("run-after-expiry", [ref])
    assert Path(saved["path"]).read_bytes() == b"one"
