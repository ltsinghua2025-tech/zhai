from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import zipfile
from pathlib import Path

from docx import Document
from openpyxl import Workbook, load_workbook
from pypdf import PdfReader
from reportlab.pdfgen import canvas


PROJECT_ROOT = Path(__file__).resolve().parents[2]
SIDECAR = Path(
    os.environ.get(
        "MATERIAL_WORKSHOP_TEST_SIDECAR",
        PROJECT_ROOT / "src-tauri/binaries/material-workshop-engine-aarch64-apple-darwin",
    )
)


def file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run_sidecar(tmp_path: Path, files: list[dict[str, object]]) -> dict[str, object]:
    request = tmp_path / "request.json"
    request.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "jobId": "format-test",
                "files": files,
                "operations": [
                    {"kind": "redact_content", "available": True, "parameters": {}},
                ],
                "outputDirectory": str(tmp_path / "task/output"),
                "reportDirectory": str(tmp_path / "task/report"),
                "temporaryDirectory": str(tmp_path / "task/.working"),
                "neverOverwrite": True,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    completed = subprocess.run(
        [str(SIDECAR), "--request", str(request)],
        capture_output=True,
        text=True,
        check=False,
        timeout=120,
    )
    assert completed.returncode == 0, completed.stderr
    events = [json.loads(line) for line in completed.stdout.splitlines()]
    return next(event["outcome"] for event in events if event["type"] == "outcome")


def test_docx_xlsx_pdf_round_trip_and_original_hashes(tmp_path: Path) -> None:
    docx_path = tmp_path / "材料.docx"
    document = Document()
    document.core_properties.author = "Sensitive Author"
    document.add_heading("一、工作安排", level=1)
    document.add_paragraph("联系人电话 13812345678，邮箱 demo@example.com")
    document.save(docx_path)

    xlsx_path = tmp_path / "汇总表.xlsx"
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "数据"
    sheet["A1"] = 1
    sheet["A2"] = 2
    sheet["A3"] = "=SUM(A1:A2)"
    sheet["B1"] = "13812345678"
    workbook.save(xlsx_path)
    workbook.close()

    pdf_path = tmp_path / "附件.pdf"
    pdf_canvas = canvas.Canvas(str(pdf_path))
    pdf_canvas.drawString(72, 760, "Material Workshop PDF sample")
    pdf_canvas.showPage()
    pdf_canvas.drawString(72, 760, "Second page")
    pdf_canvas.save()

    originals = {path: file_hash(path) for path in (docx_path, xlsx_path, pdf_path)}
    files = [
        {
            "id": f"file-{index}",
            "path": str(path),
            "name": path.name,
            "relativePath": path.name,
        }
        for index, path in enumerate((docx_path, xlsx_path, pdf_path), start=1)
    ]
    extract_request = tmp_path / "extract-request.json"
    extract_request.write_text(
        json.dumps({"schemaVersion": 1, "files": files}, ensure_ascii=False),
        encoding="utf-8",
    )
    extracted_process = subprocess.run(
        [str(SIDECAR), "--extract-request", str(extract_request)],
        capture_output=True,
        text=True,
        check=False,
        timeout=120,
    )
    assert extracted_process.returncode == 0, extracted_process.stderr
    extracted = json.loads(extracted_process.stdout)
    assert any(
        item["fileId"] == "file-1"
        and item["locator"]["kind"] == "docx_paragraph"
        and "13812345678" in item["text"]
        for item in extracted["snippets"]
    )
    assert any(
        item["fileId"] == "file-2"
        and item["locator"] == {"kind": "xlsx_cell", "sheet": "数据", "cell": "A3"}
        and item["text"] == "=SUM(A1:A2)"
        for item in extracted["snippets"]
    )
    outcome = run_sidecar(tmp_path, files)
    assert not outcome["failures"], outcome["failures"]
    assert outcome["status"] == "completed", outcome
    assert outcome["completedFiles"] == 3
    assert all(file_hash(path) == original_hash for path, original_hash in originals.items())

    output_root = tmp_path / "task/output"
    output_document = Document(output_root / docx_path.name)
    output_text = "\n".join(paragraph.text for paragraph in output_document.paragraphs)
    assert "13812345678" not in output_text
    assert "demo@example.com" not in output_text
    assert output_document.core_properties.author == ""

    output_workbook = load_workbook(output_root / xlsx_path.name, data_only=False)
    output_sheet = output_workbook["数据"]
    assert output_sheet["A3"].value == "=SUM(A1:A2)"
    assert output_sheet["B1"].value == "[手机号已脱敏]"
    output_workbook.close()

    output_pdf = PdfReader(output_root / pdf_path.name)
    assert len(output_pdf.pages) == 2
    assert output_pdf.pages[0].extract_text()
    # PDF supports metadata removal with an explicit warning, not body redaction.
    pdf_output = next(item for item in outcome["outputs"] if item["fileId"] == "file-3")
    assert any("正文默认不直接重写" in note for note in pdf_output["notes"])


def test_bundled_sidecar_generates_gongwen_docx_from_markdown(tmp_path: Path) -> None:
    source = tmp_path / "通知.md"
    source.write_text(
        "# 关于做好材料报送工作的通知\n作者：某单位\n## 一、工作要求\n请各单位按时报送。\n",
        encoding="utf-8",
    )
    request = tmp_path / "gongwen-request.json"
    request.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "jobId": "gongwen-format-test",
                "files": [{"id": "md-1", "path": str(source), "name": source.name, "relativePath": source.name}],
                "operations": [{"kind": "generate_gongwen", "available": True, "parameters": {"encoding": "utf-8-sig"}}],
                "outputDirectory": str(tmp_path / "gongwen-task/output"),
                "reportDirectory": str(tmp_path / "gongwen-task/report"),
                "neverOverwrite": True,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    completed = subprocess.run(
        [str(SIDECAR), "--request", str(request)],
        capture_output=True,
        text=True,
        check=False,
        timeout=120,
    )
    assert completed.returncode == 0, completed.stderr
    events = [json.loads(line) for line in completed.stdout.splitlines()]
    outcome = next(event["outcome"] for event in events if event["type"] == "outcome")
    assert outcome["completedFiles"] == 1, outcome["failures"]
    assert len(outcome["outputs"]) == 1
    generated = Path(outcome["outputs"][0]["path"])
    assert generated.suffix == ".docx"
    document = Document(generated)
    assert any("材料报送" in paragraph.text for paragraph in document.paragraphs)


def test_bundled_sidecar_formats_existing_docx_as_gongwen(tmp_path: Path) -> None:
    source = tmp_path / "原始公文.docx"
    document = Document()
    document.add_paragraph("关于做好测试工作的通知")
    document.add_paragraph("一、工作要求")
    document.add_paragraph("请按要求完成测试。")
    document.add_table(rows=1, cols=1).cell(0, 0).text = "表格保留"
    document.save(source)
    original_hash = file_hash(source)
    request = tmp_path / "existing-gongwen-request.json"
    request.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "jobId": "existing-gongwen-format-test",
                "files": [{"id": "docx-1", "path": str(source), "name": source.name, "relativePath": source.name}],
                "operations": [{"kind": "normalize_docx_styles", "available": True, "parameters": {"preset": "gongwen"}}],
                "outputDirectory": str(tmp_path / "existing-gongwen-task/output"),
                "reportDirectory": str(tmp_path / "existing-gongwen-task/report"),
                "neverOverwrite": True,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    completed = subprocess.run(
        [str(SIDECAR), "--request", str(request)],
        capture_output=True,
        text=True,
        check=False,
        timeout=120,
    )
    assert completed.returncode == 0, completed.stderr
    events = [json.loads(line) for line in completed.stdout.splitlines()]
    outcome = next(event["outcome"] for event in events if event["type"] == "outcome")
    assert outcome["completedFiles"] == 1, outcome["failures"]
    assert file_hash(source) == original_hash
    generated = Path(outcome["outputs"][0]["path"])
    formatted = Document(generated)
    assert [paragraph.text for paragraph in formatted.paragraphs] == [
        "关于做好测试工作的通知",
        "",
        "一、工作要求",
        "请按要求完成测试。",
    ]
    assert formatted.tables[0].cell(0, 0).text == "表格保留"
    with zipfile.ZipFile(generated) as archive:
        document_xml = archive.read("word/document.xml").decode("utf-8")
    assert "方正小标宋简体" in document_xml
    assert "仿宋_GB2312" in document_xml
    assert "黑体" in document_xml


def test_bundled_sidecar_merges_xlsx_reports_into_one_output(tmp_path: Path) -> None:
    sources: list[Path] = []
    for filename, headers, row in (
        ("甲单位.xlsx", ["姓名", "单位", "推荐理由"], ["张三", "甲单位", "优秀"]),
        ("乙单位.xlsx", ["单位", "姓名", "联系电话"], ["乙单位", "李四", "13800000000"]),
    ):
        path = tmp_path / filename
        workbook = Workbook()
        sheet = workbook.active
        sheet.append(headers)
        sheet.append(row)
        workbook.save(path)
        workbook.close()
        sources.append(path)
    original_hashes = {path: file_hash(path) for path in sources}
    request = tmp_path / "merge-xlsx-request.json"
    request.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "jobId": "merge-xlsx-format-test",
                "files": [
                    {"id": f"xlsx-{index}", "path": str(path), "name": path.name, "relativePath": path.name}
                    for index, path in enumerate(sources, start=1)
                ],
                "operations": [
                    {
                        "kind": "merge_xlsx",
                        "available": True,
                        "parameters": {"headerRow": 1, "includeSource": True},
                    }
                ],
                "outputDirectory": str(tmp_path / "merge-xlsx-task/output"),
                "reportDirectory": str(tmp_path / "merge-xlsx-task/report"),
                "neverOverwrite": True,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    completed = subprocess.run(
        [str(SIDECAR), "--request", str(request)],
        capture_output=True,
        text=True,
        check=False,
        timeout=120,
    )
    assert completed.returncode == 0, completed.stderr
    events = [json.loads(line) for line in completed.stdout.splitlines()]
    outcome = next(event["outcome"] for event in events if event["type"] == "outcome")
    assert outcome["status"] == "completed", outcome["failures"]
    assert len(outcome["outputs"]) == 1
    merged = load_workbook(outcome["outputs"][0]["path"], read_only=True, data_only=False)
    assert list(merged["汇总"].values) == [
        ("来源文件", "姓名", "单位", "推荐理由", "联系电话"),
        ("甲单位.xlsx", "张三", "甲单位", "优秀", None),
        ("乙单位.xlsx", "李四", "乙单位", None, "13800000000"),
    ]
    merged.close()
    assert all(file_hash(path) == original_hash for path, original_hash in original_hashes.items())


def test_bundled_sidecar_runs_agent_script_inside_macos_sandbox(tmp_path: Path) -> None:
    if sys.platform != "darwin":
        return
    input_dir = tmp_path / "inputs"
    output_dir = tmp_path / "outputs"
    input_dir.mkdir()
    output_dir.mkdir()
    runtime_dir = tmp_path / "runtime"
    runtime_dir.mkdir()
    (input_dir / "材料.txt").write_text("原始材料", encoding="utf-8")
    script = tmp_path / "skill.py"
    script.write_text(
        "import mimetypes\n"
        "from pathlib import Path\n"
        "from openpyxl import Workbook\n"
        "def run(context):\n"
        "    source = next(Path(context['input_dir']).iterdir())\n"
        "    target = Path(context['output_dir']) / '成果.txt'\n"
        "    try:\n"
        "        Path('/private/etc/hosts').read_text()\n"
        "        blocked = ' 未隔离'\n"
        "    except PermissionError:\n"
        "        blocked = ' 已隔离'\n"
        "    assert mimetypes.guess_type('成果.xlsx')[0] is not None\n"
        "    workbook_target = Path(context['output_dir']) / '成果.xlsx'\n"
        "    workbook = Workbook()\n"
        "    workbook.active.append(['姓名', '最后职务', '任职时间'])\n"
        "    workbook.active.append(['张三', '科长', '2026年8月'])\n"
        "    workbook.save(workbook_target)\n"
        "    workbook.close()\n"
        "    target.write_text(source.read_text(encoding='utf-8') + ' 已处理' + blocked, encoding='utf-8')\n"
        "    return {'summary': '完成', 'outputs': [str(target), str(workbook_target)]}\n",
        encoding="utf-8",
    )
    request = tmp_path / "request.json"
    request.write_text(
        json.dumps({
            "schemaVersion": 1,
            "neverOverwrite": True,
            "scriptPath": str(script),
            "inputDirectory": str(input_dir),
            "outputDirectory": str(output_dir),
        }, ensure_ascii=False),
        encoding="utf-8",
    )
    escaped_root = str(tmp_path).replace("\\", "\\\\").replace('"', '\\"')
    escaped_sidecar = str(SIDECAR).replace("\\", "\\\\").replace('"', '\\"')
    profile = f'''(version 1)
(deny default)
(import "system.sb")
(allow process*)
(allow sysctl*)
(allow ipc-posix* ipc-sysv*)
(allow file-read-metadata)
(allow file-read*
  (literal "{escaped_sidecar}")
  (subpath "{escaped_root}")
  (subpath "/System/Library")
  (subpath "/Library/Fonts")
  (subpath "/usr/lib")
  (subpath "/usr/share")
  (literal "/etc/apache2/mime.types")
  (literal "/private/etc/apache2/mime.types")
  (literal "/etc/mime.types")
  (literal "/private/etc/mime.types"))
(allow file-write* (subpath "{escaped_root}"))'''
    environment = os.environ.copy()
    environment["TMPDIR"] = str(runtime_dir)
    completed = subprocess.run(
        ["/usr/bin/sandbox-exec", "-p", profile, str(SIDECAR), "--run-agent-script", str(request)],
        capture_output=True,
        text=True,
        env=environment,
        check=False,
        timeout=120,
    )
    assert completed.returncode == 0, completed.stderr
    result = json.loads(completed.stdout)
    assert result["summary"] == "完成"
    assert Path(result["outputs"][0]).read_text(encoding="utf-8") == "原始材料 已处理 已隔离"
    workbook = load_workbook(result["outputs"][1], read_only=True)
    assert workbook.active.max_row == 2
    workbook.close()


def test_agent_script_can_read_multiple_cadre_docx_and_create_verified_xlsx(tmp_path: Path) -> None:
    """Regression for the real workflow: read several cadre forms and build a roster."""
    if sys.platform != "darwin":
        return
    input_dir = tmp_path / "干部材料"
    output_dir = tmp_path / "成果"
    runtime_dir = tmp_path / "runtime"
    input_dir.mkdir()
    output_dir.mkdir()
    runtime_dir.mkdir()
    for filename, lines in {
        "张三.docx": ["姓名：张三", "任职经历", "2022年3月 科员", "2025年6月 综合科科长"],
        "李四.docx": ["姓名：李四", "任职经历", "2021年1月 副主任", "2026年2月 办公室主任"],
    }.items():
        document = Document()
        for line in lines:
            document.add_paragraph(line)
        document.save(input_dir / filename)

    script = tmp_path / "cadre_roster.py"
    script.write_text(
        "import re\n"
        "from pathlib import Path\n"
        "from docx import Document\n"
        "from openpyxl import Workbook\n"
        "def run(context):\n"
        "    rows = []\n"
        "    for source in sorted(Path(context['input_dir']).glob('*.docx')):\n"
        "        lines = [p.text.strip() for p in Document(source).paragraphs if p.text.strip()]\n"
        "        name = next(line.split('：', 1)[1] for line in lines if line.startswith('姓名：'))\n"
        "        dated = [line for line in lines if re.match(r'\\d{4}年\\d{1,2}月', line)]\n"
        "        match = re.match(r'(\\d{4}年\\d{1,2}月)\\s+(.+)', dated[-1])\n"
        "        rows.append([name, match.group(2), match.group(1)])\n"
        "    target = Path(context['output_dir']) / '干部任职汇总.xlsx'\n"
        "    book = Workbook()\n"
        "    sheet = book.active\n"
        "    sheet.title = '任职汇总'\n"
        "    sheet.append(['姓名', '最后职务', '任职时间'])\n"
        "    for row in rows: sheet.append(row)\n"
        "    book.save(target)\n"
        "    book.close()\n"
        "    return {'summary': f'汇总{len(rows)}人', 'outputs': [str(target)]}\n",
        encoding="utf-8",
    )
    request = tmp_path / "request.json"
    request.write_text(json.dumps({
        "schemaVersion": 1,
        "neverOverwrite": True,
        "scriptPath": str(script),
        "inputDirectory": str(input_dir),
        "outputDirectory": str(output_dir),
    }, ensure_ascii=False), encoding="utf-8")
    escaped_root = str(tmp_path).replace("\\", "\\\\").replace('"', '\\"')
    escaped_sidecar = str(SIDECAR).replace("\\", "\\\\").replace('"', '\\"')
    profile = f'''(version 1)
(deny default)
(import "system.sb")
(allow process*)
(allow sysctl*)
(allow ipc-posix* ipc-sysv*)
(allow file-read-metadata)
(allow file-read* (literal "{escaped_sidecar}") (subpath "{escaped_root}")
  (subpath "/System/Library") (subpath "/Library/Fonts")
  (subpath "/usr/lib") (subpath "/usr/share")
  (literal "/etc/apache2/mime.types")
  (literal "/private/etc/apache2/mime.types")
  (literal "/etc/mime.types")
  (literal "/private/etc/mime.types"))
(allow file-write* (subpath "{escaped_root}"))'''
    environment = os.environ.copy()
    environment["TMPDIR"] = str(runtime_dir)
    completed = subprocess.run(
        ["/usr/bin/sandbox-exec", "-p", profile, str(SIDECAR), "--run-agent-script", str(request)],
        capture_output=True, text=True, env=environment, check=False, timeout=120,
    )
    assert completed.returncode == 0, completed.stderr
    result = json.loads(completed.stdout)
    assert result["summary"] == "汇总2人"
    workbook = load_workbook(result["outputs"][0], read_only=True, data_only=False)
    assert list(workbook.active.values) == [
        ("姓名", "最后职务", "任职时间"),
        ("张三", "综合科科长", "2025年6月"),
        ("李四", "办公室主任", "2026年2月"),
    ]
    workbook.close()
