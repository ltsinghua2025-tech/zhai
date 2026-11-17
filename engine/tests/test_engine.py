from __future__ import annotations

import json
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from openpyxl import Workbook, load_workbook
from pypdf import PdfReader

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import material_workshop_engine as engine

from material_workshop_engine import (
    convert_office_with_libreoffice,
    convert_office_with_wps,
    libreoffice_path,
    merge_xlsx_files,
    normalize_whitespace_text,
    process_file,
    redact_text,
    run_agent_script,
    run_extraction,
    safe_relative_path,
    validate_artifact,
    validate_pdf_conversion,
    wps_bridge_path,
)


def test_agent_script_runs_against_snapshot_and_only_reports_outputs(tmp_path: Path) -> None:
    input_dir = tmp_path / "inputs"
    output_dir = tmp_path / "outputs"
    input_dir.mkdir()
    (input_dir / "材料.txt").write_text("需要处理的内容", encoding="utf-8")
    script = tmp_path / "skill.py"
    script.write_text(
        "from pathlib import Path\n"
        "def run(context):\n"
        "    source = next(Path(context['input_dir']).iterdir())\n"
        "    target = Path(context['output_dir']) / '成果.txt'\n"
        "    target.write_text(source.read_text(encoding='utf-8') + '（已处理）', encoding='utf-8')\n"
        "    return {'summary': '处理完成', 'outputs': [str(target), '/etc/hosts']}\n",
        encoding="utf-8",
    )
    request = tmp_path / "agent-script.json"
    request.write_text(
        json.dumps({"schemaVersion": 1, "neverOverwrite": True, "scriptPath": str(script), "inputDirectory": str(input_dir), "outputDirectory": str(output_dir)}, ensure_ascii=False),
        encoding="utf-8",
    )

    result = run_agent_script(request)

    assert result["summary"] == "处理完成"
    assert result["outputs"] == [str((output_dir / "成果.txt").resolve())]
    assert (output_dir / "成果.txt").read_text(encoding="utf-8").endswith("（已处理）")


def test_packaged_resources_and_helpers_are_available_to_scripts(tmp_path: Path) -> None:
    inputs = tmp_path / "inputs"
    resources = tmp_path / "resources"
    outputs = tmp_path / "outputs"
    inputs.mkdir()
    (resources / "assets").mkdir(parents=True)
    (resources / "scripts").mkdir()
    (resources / "assets" / "模板.txt").write_text("报送规则", encoding="utf-8")
    (resources / "scripts" / "zhai_test_helper.py").write_text("SUFFIX = '已核验'", encoding="utf-8")
    source = tmp_path / "main.py"
    source.write_text("from zhai_test_helper import SUFFIX\ndef run(context, params):\n    text=(context.resources_dir / 'assets' / '模板.txt').read_text(encoding='utf-8')\n    path=context.output_dir / 'result.txt'\n    path.write_text(text+SUFFIX,encoding='utf-8')\n    return {'outputs':[str(path)]}\n", encoding="utf-8")
    request = tmp_path / "request.json"
    request.write_text(json.dumps({"schemaVersion":1,"neverOverwrite":True,"scriptPath":str(source),"inputDirectory":str(inputs),"outputDirectory":str(outputs),"resourcesDirectory":str(resources)}),encoding="utf-8")
    result = run_agent_script(request)
    assert Path(result["outputs"][0]).read_text(encoding="utf-8") == "报送规则已核验"
    assert (resources / "assets" / "模板.txt").read_text(encoding="utf-8") == "报送规则"


def test_legacy_two_argument_skill_receives_parameters(tmp_path: Path) -> None:
    input_dir = tmp_path / "inputs"
    output_dir = tmp_path / "outputs"
    input_dir.mkdir()
    script = tmp_path / "skill.py"
    script.write_text(
        "from pathlib import Path\n"
        "def run(context, params):\n"
        "    target = Path(context['output_dir']) / '参数.txt'\n"
        "    target.write_text(params.get('label', 'missing'), encoding='utf-8')\n"
        "    return {'outputs': [str(target)]}\n",
        encoding="utf-8",
    )
    request = tmp_path / "agent-script.json"
    request.write_text(
        json.dumps({
            "schemaVersion": 1,
            "neverOverwrite": True,
            "scriptPath": str(script),
            "inputDirectory": str(input_dir),
            "outputDirectory": str(output_dir),
            "parameters": {"label": "已兼容"},
        }, ensure_ascii=False),
        encoding="utf-8",
    )
    result = run_agent_script(request)
    assert Path(result["outputs"][0]).read_text(encoding="utf-8") == "已兼容"


@pytest.mark.parametrize("limit, expected", [(None, 2), (1, 1), (0, 2)])
def test_dual_context_skill_mapping_inputs_match_attributes(tmp_path: Path, limit, expected) -> None:
    inputs = tmp_path / "inputs"
    outputs = tmp_path / "outputs"
    inputs.mkdir()
    for name in ["02.txt", "01.txt"]:
        (inputs / name).write_text(name)
    script = tmp_path / "skill.py"
    script.write_text(
        "from pathlib import Path\n"
        "def run(context, params):\n"
        "    paths = context.get('inputs', []) if isinstance(context, dict) else context.inputs\n"
        "    assert [Path(p) for p in paths] == context.inputs\n"
        "    target = context.output_dir / 'result.txt'\n"
        "    target.write_text('|'.join(Path(p).read_text() for p in paths))\n"
        "    return {'outputs': [str(target)]}\n"
    )
    request = tmp_path / "request.json"
    request.write_text(json.dumps({"schemaVersion": 1, "neverOverwrite": True,
        "scriptPath": str(script), "inputDirectory": str(inputs), "outputDirectory": str(outputs),
        "parameters": {"__material_workbench_sample_limit": limit}}))
    result = run_agent_script(request)
    assert Path(result["outputs"][0]).read_text() == "|".join(["01.txt", "02.txt"][:expected])


def test_redaction_covers_common_fields() -> None:
    result, count = redact_text("13812345678 11010519491231002X demo@example.com")
    assert count == 3
    assert "13812345678" not in result
    assert "demo@example.com" not in result


def test_redaction_validates_chinese_identifiers_and_uses_context() -> None:
    text = "姓名：张三；银行卡4111111111111111；信用代码91310000677833266F"
    result, count = redact_text(text)
    assert count == 3
    assert "张三" not in result
    assert "4111111111111111" not in result
    assert "91310000677833266F" not in result
    invalid, invalid_count = redact_text("身份证号440101199001011234 银行卡4111111111111112")
    assert invalid_count == 0
    assert "440101199001011234" in invalid
    telephone, telephone_count = redact_text("联系电话：0756-1234567")
    assert telephone_count == 1
    assert telephone == "联系电话：[电话已脱敏]"


def test_redaction_uses_adjacent_table_field_context() -> None:
    result, count = redact_text("李四", "姓名")
    assert result == "[姓名已脱敏]"
    assert count == 1


def test_redaction_chinese_adjacent_email_and_narrative_labels() -> None:
    text = "报名单位共18家，负责人应及时联系，地址信息另行通知。邮箱zhangxiaozhou@example.com。"
    result, count = redact_text(text)
    assert count == 1
    assert result == "报名单位共18家，负责人应及时联系，地址信息另行通知。邮箱[邮箱已脱敏]。"
    assert redact_text("18", "报名单位数") == ("18", 0)
    assert redact_text("联系负责人", "处理要求") == ("联系负责人", 0)
    labeled, count = redact_text("单位：测试服务中心；联系人 张三；地址：演示路1号")
    assert count == 3
    assert labeled == "单位：[单位已脱敏]；联系人 [姓名已脱敏]；地址：[地址已脱敏]"


def test_docx_converts_to_verified_pdf_with_libreoffice(tmp_path: Path) -> None:
    if libreoffice_path() is None:
        pytest.skip("LibreOffice is not installed")
    source = tmp_path / "中文转换测试.docx"
    document = Document()
    document.add_paragraph("珠海市政务材料中文转换测试。" * 3)
    document.save(source)
    target = tmp_path / "中文转换测试.pdf"
    result = convert_office_with_libreoffice(source, target, "docx-to-pdf")
    assert target.is_file()
    assert "cjk=" in result["verification"]


def test_relative_path_cannot_escape_output() -> None:
    assert safe_relative_path("../../资料/文件.docx", "fallback.docx") == Path("资料/文件.docx")


def test_whitespace_normalizer_keeps_english_word_boundaries() -> None:
    value, changes = normalize_whitespace_text("中文  之间 English  words")
    assert value == "中文之间 English words"
    assert changes == 3


def test_generated_xlsx_must_reopen_before_becoming_an_artifact(tmp_path: Path) -> None:
    workbook_path = tmp_path / "干部信息.xlsx"
    workbook = Workbook()
    sheet = workbook.active
    sheet.append(["姓名", "最后职务", "任职时间"])
    sheet.append(["张三", "科长", "2026年8月"])
    workbook.save(workbook_path)
    workbook.close()
    result = validate_artifact(workbook_path)
    assert result["valid"] is True
    assert result["detail"]["sheets"] == 1

    broken = tmp_path / "损坏成果.xlsx"
    broken.write_text("not a workbook", encoding="utf-8")
    with pytest.raises(Exception):
        validate_artifact(broken)


@pytest.mark.parametrize("case, message", [
    ("merged", "合并单元格"),
    ("duplicate", "重复表头"),
    ("blank", "缺少表头"),
    ("formula", "含公式"),
])
def test_merge_rejects_ambiguous_fields_without_publishing(tmp_path: Path, case: str, message: str) -> None:
    sources = []
    for index in range(2):
        path = tmp_path / f"样本{index}.xlsx"
        workbook = Workbook()
        sheet = workbook.active
        sheet.append(["单位", "人数"])
        sheet.append(["测试单位", 3])
        if index == 1:
            if case == "merged": sheet.merge_cells("A1:B1")
            elif case == "duplicate": sheet["B1"] = "单位"
            elif case == "blank": sheet["B1"] = None
            else: sheet["B2"] = "=1+2"
        workbook.save(path)
        workbook.close()
        sources.append(path)
    original_hashes = [engine.checksum(path) for path in sources]
    output = tmp_path / "output"
    output.mkdir()
    with pytest.raises(RuntimeError, match=message):
        merge_xlsx_files([{"path": str(path)} for path in sources], output, {})
    assert list(output.iterdir()) == []
    assert [engine.checksum(path) for path in sources] == original_hashes


def test_merge_xlsx_aligns_columns_and_preserves_sources(tmp_path: Path) -> None:
    first = tmp_path / "甲单位.xlsx"
    workbook = Workbook()
    sheet = workbook.active
    sheet.append(["姓名", "单位", "推荐理由"])
    sheet.append(["张三", "甲单位", "表现优秀"])
    sheet.append([None, None, None])
    workbook.save(first)
    workbook.close()

    second = tmp_path / "乙单位.xlsx"
    workbook = Workbook()
    sheet = workbook.active
    sheet.append(["单位", "姓名", "联系电话"])
    sheet.append(["乙单位", "李四", "13800000000"])
    workbook.save(second)
    workbook.close()
    originals = {path: engine.checksum(path) for path in (first, second)}

    output = tmp_path / "output"
    output.mkdir()
    target, rows, sources = merge_xlsx_files(
        [
            {"path": str(first)},
            {"path": str(second)},
        ],
        output,
        {"headerRow": 1, "includeSource": True},
    )

    assert rows == 2
    assert sources == 2
    merged = load_workbook(target, data_only=False)
    sheet = merged["汇总"]
    assert [cell.value for cell in sheet[1]] == ["来源文件", "姓名", "单位", "推荐理由", "联系电话"]
    assert [cell.value for cell in sheet[2]] == ["甲单位.xlsx", "张三", "甲单位", "表现优秀", None]
    assert [cell.value for cell in sheet[3]] == ["乙单位.xlsx", "李四", "乙单位", None, "13800000000"]
    assert sheet.freeze_panes == "A2"
    merged.close()
    assert all(engine.checksum(path) == original_hash for path, original_hash in originals.items())


def test_markdown_generates_verified_gongwen_docx_without_changing_source(tmp_path: Path) -> None:
    source = tmp_path / "公文草稿.md"
    source.write_text(
        "# 关于做好材料报送工作的通知\n作者：某单位\n## 一、工作要求\n请各单位按时报送材料。\n### （一）明确时间\n二零二六年八月十日前完成。\n",
        encoding="utf-8",
    )
    source_before = source.read_bytes()
    output = tmp_path / "output"
    output.mkdir()
    result = process_file(
        {"id": "md-1", "path": str(source), "relativePath": source.name},
        output,
        {"generate_gongwen"},
        {"generate_gongwen": {"encoding": "utf-8-sig"}},
        [],
    )
    assert source.read_bytes() == source_before
    target = Path(result.output)
    assert target.suffix == ".docx"
    document = Document(target)
    assert any("关于做好材料报送" in paragraph.text for paragraph in document.paragraphs)
    section = document.sections[0]
    assert round(section.top_margin.cm, 1) == 3.7
    assert round(section.left_margin.cm, 1) == 2.8
    with zipfile.ZipFile(target) as archive:
        document_xml = archive.read("word/document.xml").decode("utf-8")
        settings_xml = archive.read("word/settings.xml").decode("utf-8")
    assert "方正小标宋简体" in document_xml
    assert "仿宋_GB2312" in document_xml
    assert "Times New Roman" in document_xml
    assert "evenAndOddHeaders" in settings_xml


def test_existing_docx_is_formatted_as_gongwen_without_rebuilding_or_overwriting_source(tmp_path: Path) -> None:
    source = tmp_path / "原始材料.docx"
    document = Document()
    document.add_paragraph("关于做好材料报送工作的通知")
    document.add_paragraph("一、工作要求")
    body = document.add_paragraph()
    emphasized = body.add_run("请各单位按时报送材料。")
    emphasized.bold = True
    table = document.add_table(rows=1, cols=1)
    table.cell(0, 0).text = "附件内容"
    document.save(source)
    source_before = source.read_bytes()
    output = tmp_path / "output"
    output.mkdir()

    result = process_file(
        {"id": "docx-1", "path": str(source), "relativePath": source.name},
        output,
        {"normalize_docx_styles"},
        {
            "normalize_docx_styles": {
                "preset": "gongwen",
                "preserveBold": True,
                "addTitleBlankLine": True,
                "lineSpacingPt": 30,
            }
        },
        [],
    )

    assert source.read_bytes() == source_before
    target = Path(result.output)
    formatted = Document(target)
    assert [paragraph.text for paragraph in formatted.paragraphs] == [
        "关于做好材料报送工作的通知",
        "",
        "一、工作要求",
        "请各单位按时报送材料。",
    ]
    assert formatted.tables[0].cell(0, 0).text == "附件内容"
    assert formatted.paragraphs[0].alignment == WD_ALIGN_PARAGRAPH.CENTER
    assert formatted.paragraphs[3].runs[0].bold is True
    assert formatted.paragraphs[3].paragraph_format.line_spacing.pt == 30
    section = formatted.sections[0]
    assert round(section.top_margin.cm, 1) == 3.7
    assert round(section.left_margin.cm, 1) == 2.8
    with zipfile.ZipFile(target) as archive:
        document_xml = archive.read("word/document.xml").decode("utf-8")
        settings_xml = archive.read("word/settings.xml").decode("utf-8")
        footer_xml = "".join(
            archive.read(name).decode("utf-8")
            for name in archive.namelist()
            if name.startswith("word/footer") and name.endswith(".xml")
        )
    assert "方正小标宋简体" in document_xml
    assert "仿宋_GB2312" in document_xml
    assert "黑体" in document_xml
    assert "Times New Roman" in document_xml
    assert "evenAndOddHeaders" in settings_xml
    assert "PAGE" in footer_xml
    assert any("原件未覆盖" in note for note in result.notes)
    assert any("保留原有加粗=是" in note for note in result.notes)


def test_gongwen_parameters_can_replace_existing_bold_and_disable_page_numbers(tmp_path: Path) -> None:
    source = tmp_path / "参数样本.docx"
    document = Document()
    document.add_paragraph("关于参数化排版的通知")
    body = document.add_paragraph()
    bold_run = body.add_run("原文中的加粗内容")
    bold_run.bold = True
    document.save(source)
    output = tmp_path / "output"
    output.mkdir()

    result = process_file(
        {"id": "docx-parameters", "path": str(source), "relativePath": source.name},
        output,
        {"normalize_docx_styles"},
        {
            "normalize_docx_styles": {
                "preset": "gongwen",
                "preserveBold": False,
                "applyPageNumbers": False,
                "formatTables": False,
                "addTitleBlankLine": False,
            }
        },
        [],
    )

    formatted = Document(result.output)
    assert formatted.paragraphs[1].runs[0].bold is False
    with zipfile.ZipFile(result.output) as archive:
        settings_xml = archive.read("word/settings.xml").decode("utf-8")
        footer_xml = "".join(
            archive.read(name).decode("utf-8")
            for name in archive.namelist()
            if name.startswith("word/footer") and name.endswith(".xml")
        )
    assert "evenAndOddHeaders" not in settings_xml
    assert "PAGE" not in footer_xml


def test_docx_can_convert_to_verified_pdf_when_wps_bridge_is_available(tmp_path: Path) -> None:
    if wps_bridge_path() is None:
        pytest.skip("verified WPS bridge is not installed")
    source = tmp_path / "转换样本.docx"
    document = Document()
    document.add_paragraph("材料助手转换测试")
    document.save(source)
    target = tmp_path / "转换样本.pdf"
    result = convert_office_with_wps(source, target, "docx-to-pdf")
    assert target.is_file()
    assert target.stat().st_size > 0
    assert result["verification"].endswith("_pages_reopened")


def test_office_conversion_prefers_verified_wps_before_libreoffice(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "样本.docx"
    target = tmp_path / "样本.pdf"
    source.write_bytes(b"fixture")
    calls: list[str] = []

    monkeypatch.setattr(engine, "wps_bridge_path", lambda: Path("/verified/wps-bridge"))
    monkeypatch.setattr(engine, "libreoffice_path", lambda: Path("/Applications/LibreOffice.app"))

    def use_wps(*_args: object, **_kwargs: object) -> dict[str, object]:
        calls.append("wps")
        return {"changes": 1, "notes": ["WPS"], "verification": "verified"}

    def use_libreoffice(*_args: object, **_kwargs: object) -> dict[str, object]:
        calls.append("libreoffice")
        return {"changes": 1, "notes": ["LibreOffice"], "verification": "fallback"}

    monkeypatch.setattr(engine, "convert_office_with_wps", use_wps)
    monkeypatch.setattr(engine, "convert_office_with_libreoffice", use_libreoffice)

    result = engine.convert_office(source, target, "docx-to-pdf")
    assert calls == ["wps"]
    assert result["verification"] == "verified"


def test_office_conversion_reports_libreoffice_as_explicit_wps_fallback(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "样本.docx"
    target = tmp_path / "样本.pdf"
    source.write_bytes(b"fixture")
    calls: list[str] = []

    monkeypatch.setattr(engine, "wps_bridge_path", lambda: Path("/verified/wps-bridge"))
    monkeypatch.setattr(engine, "libreoffice_path", lambda: Path("/Applications/LibreOffice.app"))

    def fail_wps(*_args: object, **_kwargs: object) -> dict[str, object]:
        calls.append("wps")
        raise RuntimeError("桥接执行失败")

    def use_libreoffice(*_args: object, **_kwargs: object) -> dict[str, object]:
        calls.append("libreoffice")
        return {"changes": 1, "notes": [], "verification": "fallback"}

    monkeypatch.setattr(engine, "convert_office_with_wps", fail_wps)
    monkeypatch.setattr(engine, "convert_office_with_libreoffice", use_libreoffice)

    result = engine.convert_office(source, target, "docx-to-pdf")
    assert calls == ["wps", "libreoffice"]
    assert result["notes"][0].startswith("WPS 优先转换未通过")


def test_content_edits_are_applied_before_pdf_conversion(tmp_path: Path) -> None:
    if wps_bridge_path() is None:
        pytest.skip("verified WPS bridge is not installed")
    source = tmp_path / "待清理.docx"
    document = Document()
    document.add_paragraph("材料  助手")
    document.save(source)
    output = tmp_path / "任务" / "output"
    request = tmp_path / "request.json"
    request.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "jobId": "edit-before-convert",
                "files": [{
                    "id": "docx-1",
                    "path": str(source),
                    "name": source.name,
                    "relativePath": source.name,
                }],
                "operations": [
                    {
                        "kind": "normalize_whitespace",
                        "available": True,
                        "parameters": {"collapseSpaces": True, "removeEmptyParagraphs": True},
                    },
                    {"kind": "convert_to_pdf", "available": True, "parameters": {}},
                ],
                "outputDirectory": str(output),
                "reportDirectory": str(tmp_path / "任务" / "report"),
                "neverOverwrite": True,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    process = subprocess.run(
        [sys.executable, str(Path(__file__).parents[1] / "material_workshop_engine.py"), "--request", str(request)],
        capture_output=True,
        text=True,
        check=False,
        timeout=180,
    )
    assert process.returncode == 0, process.stderr
    pdf = PdfReader(output / "待清理.pdf")
    assert len(pdf.pages) >= 1
    report = json.loads(
        (tmp_path / "任务" / "report" / "processing-report.json").read_text(encoding="utf-8")
    )
    assert report["files"][0]["changes"] >= 1
    assert "structure_reopened;" in report["files"][0]["verification"]


def test_chinese_text_loss_is_rejected(tmp_path: Path) -> None:
    source = tmp_path / "中文样本.docx"
    document = Document()
    document.add_paragraph("这是用于验证中文保真的材料内容。" * 8)
    document.save(source)
    broken_pdf = tmp_path / "broken.pdf"
    from reportlab.pdfgen import canvas

    pdf_canvas = canvas.Canvas(str(broken_pdf))
    pdf_canvas.drawString(72, 760, "English fallback only")
    pdf_canvas.save()
    with pytest.raises(RuntimeError, match="中文保真校验失败"):
        validate_pdf_conversion(source, broken_pdf)


def test_request_requires_never_overwrite(tmp_path: Path) -> None:
    request = tmp_path / "request.json"
    request.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "jobId": "test",
                "files": [],
                "operations": [],
                "outputDirectory": str(tmp_path / "out"),
                "reportDirectory": str(tmp_path / "report"),
                "neverOverwrite": False,
            }
        ),
        encoding="utf-8",
    )
    process = subprocess.run(
        [sys.executable, str(Path(__file__).parents[1] / "material_workshop_engine.py"), "--request", str(request)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert process.returncode == 1
    assert "neverOverwrite" in process.stderr


def test_batch_copy_continues_after_one_failure(tmp_path: Path) -> None:
    csv_path = tmp_path / "有效.csv"
    csv_path.write_text("姓名,电话\n张三,13812345678\n", encoding="utf-8")
    output = tmp_path / "任务" / "output"
    report = tmp_path / "任务" / "report"
    request = tmp_path / "request.json"
    request.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "jobId": "job-1",
                "files": [
                    {
                        "id": "ok",
                        "path": str(csv_path),
                        "name": csv_path.name,
                        "relativePath": csv_path.name,
                    },
                    {
                        "id": "missing",
                        "path": str(tmp_path / "不存在.csv"),
                        "name": "不存在.csv",
                        "relativePath": "不存在.csv",
                    },
                ],
                "operations": [
                    {
                        "kind": "redact_content",
                        "available": True,
                        "parameters": {},
                    }
                ],
                "outputDirectory": str(output),
                "reportDirectory": str(report),
                "neverOverwrite": True,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    process = subprocess.run(
        [sys.executable, str(Path(__file__).parents[1] / "material_workshop_engine.py"), "--request", str(request)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert process.returncode == 0
    events = [json.loads(line) for line in process.stdout.splitlines()]
    outcome = next(event["outcome"] for event in events if event["type"] == "outcome")
    assert outcome["completedFiles"] == 1
    assert outcome["failedFiles"] == 1
    assert "13812345678" not in (output / "有效.csv").read_text(encoding="utf-8-sig")
    assert csv_path.read_text(encoding="utf-8") == "姓名,电话\n张三,13812345678\n"


def test_multiple_model_replace_calls_are_all_applied(tmp_path: Path) -> None:
    csv_path = tmp_path / "日期.csv"
    csv_path.write_text("事项,日期\n开会,2026年8月15日\n报送,2026年8月16日\n", encoding="utf-8")
    output = tmp_path / "任务" / "output"
    request = tmp_path / "request.json"
    request.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "jobId": "multi-replace",
                "files": [{
                    "id": "csv-1",
                    "path": str(csv_path),
                    "name": csv_path.name,
                    "relativePath": csv_path.name,
                }],
                "operations": [
                    {
                        "kind": "replace_text",
                        "available": True,
                        "parameters": {
                            "replacements": [{"before": "2026年8月15日", "after": "2026年8月20日"}]
                        },
                    },
                    {
                        "kind": "replace_text",
                        "available": True,
                        "parameters": {
                            "replacements": [{"before": "2026年8月16日", "after": "2026年8月20日"}]
                        },
                    },
                ],
                "outputDirectory": str(output),
                "reportDirectory": str(tmp_path / "任务" / "report"),
                "neverOverwrite": True,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    process = subprocess.run(
        [sys.executable, str(Path(__file__).parents[1] / "material_workshop_engine.py"), "--request", str(request)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert process.returncode == 0, process.stderr
    processed = (output / csv_path.name).read_text(encoding="utf-8-sig")
    assert processed.count("2026年8月20日") == 2
    assert "2026年8月15日" not in processed
    assert "2026年8月16日" not in processed


def test_structured_extraction_returns_stable_docx_and_xlsx_locators(tmp_path: Path) -> None:
    docx_path = tmp_path / "方案.docx"
    document = Document()
    document.add_paragraph("实施日期为2026年8月15日")
    document.save(docx_path)
    xlsx_path = tmp_path / "报名表.xlsx"
    workbook = Workbook()
    workbook.active.title = "报名"
    workbook.active["D6"] = "2026年8月16日"
    workbook.save(xlsx_path)
    workbook.close()
    request = tmp_path / "extract.json"
    request.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "files": [
                    {"id": "docx-1", "path": str(docx_path)},
                    {"id": "xlsx-1", "path": str(xlsx_path)},
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    result = run_extraction(request)
    assert not result["errors"]
    assert any(
        item["fileId"] == "docx-1"
        and item["locator"] == {"kind": "docx_paragraph", "index": 0}
        and item["text"] == "实施日期为2026年8月15日"
        for item in result["snippets"]
    )
    assert any(
        item["fileId"] == "xlsx-1"
        and item["locator"] == {"kind": "xlsx_cell", "sheet": "报名", "cell": "D6"}
        and item["text"] == "2026年8月16日"
        for item in result["snippets"]
    )


def test_remove_line_breaks_and_update_date_in_docx(tmp_path: Path) -> None:
    source = tmp_path / "通知.docx"
    document = Document()
    document.add_paragraph("会议日期：2026年8月8日\n请准时参加")
    document.save(source)
    output = tmp_path / "output"
    output.mkdir()
    process_file(
        {"id": "docx-1", "path": str(source), "relativePath": source.name},
        output,
        {"remove_line_breaks", "update_dates"},
        {
            "remove_line_breaks": {"joinParagraphs": False},
            "replace_text": {
                "replacements": [{"before": "2026年8月8日", "after": "2026年8月15日"}]
            },
        },
        [],
    )
    text = "\n".join(paragraph.text for paragraph in Document(output / source.name).paragraphs)
    assert "2026年8月15日" in text
    assert "\n" not in text


def test_csv_to_xlsx_keeps_chinese_content(tmp_path: Path) -> None:
    source = tmp_path / "名单.csv"
    source.write_text("姓名,部门\n林晓,办公室\n", encoding="utf-8")
    output = tmp_path / "output"
    output.mkdir()
    result = process_file(
        {"id": "csv-1", "path": str(source), "relativePath": source.name},
        output,
        {"csv_to_xlsx"},
        {},
        [],
    )
    workbook = load_workbook(result.output)
    assert workbook.active["A2"].value == "林晓"
    assert workbook.active["B2"].value == "办公室"
    workbook.close()


def test_pdf_page_extraction_uses_one_based_ranges(tmp_path: Path) -> None:
    source = tmp_path / "三页.pdf"
    from reportlab.pdfgen import canvas

    pdf_canvas = canvas.Canvas(str(source))
    for page_number in range(1, 4):
        pdf_canvas.drawString(72, 760, f"Page {page_number}")
        pdf_canvas.showPage()
    pdf_canvas.save()
    output = tmp_path / "output"
    output.mkdir()
    result = process_file(
        {"id": "pdf-1", "path": str(source), "relativePath": source.name},
        output,
        {"split_pdf"},
        {"split_pdf": {"pages": "1,3"}},
        [],
    )
    reader = PdfReader(result.output)
    assert len(reader.pages) == 2
    assert "Page 1" in (reader.pages[0].extract_text() or "")
    assert "Page 3" in (reader.pages[1].extract_text() or "")


def test_ai_review_applies_to_output_and_legacy_file_is_skipped(tmp_path: Path) -> None:
    xlsx_path = tmp_path / "日期.xlsx"
    workbook = Workbook()
    workbook.active.title = "报名"
    workbook.active["D6"] = "2026年8月16日"
    workbook.save(xlsx_path)
    workbook.close()
    legacy_path = tmp_path / "旧表.xls"
    legacy_path.write_bytes(b"legacy-placeholder")
    output = tmp_path / "任务" / "output"
    report = tmp_path / "任务" / "report"
    request = tmp_path / "request.json"
    request.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "jobId": "ai-review",
                "files": [{
                    "id": "xlsx-1",
                    "path": str(xlsx_path),
                    "name": xlsx_path.name,
                    "relativePath": xlsx_path.name,
                }],
                "skips": [{
                    "fileId": "legacy-1",
                    "path": str(legacy_path),
                    "reason": "旧版 DOC/XLS 默认跳过",
                }],
                "operations": [],
                "aiReviews": [{
                    "id": "review-1",
                    "fileId": "xlsx-1",
                    "locator": {"kind": "xlsx_cell", "sheet": "报名", "cell": "D6"},
                    "before": "2026年8月16日",
                    "after": "2026年8月15日",
                    "reason": "统一日期",
                    "confidence": 0.93,
                }],
                "outputDirectory": str(output),
                "reportDirectory": str(report),
                "neverOverwrite": True,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    process = subprocess.run(
        [sys.executable, str(Path(__file__).parents[1] / "material_workshop_engine.py"), "--request", str(request)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert process.returncode == 0, process.stderr
    events = [json.loads(line) for line in process.stdout.splitlines()]
    outcome = next(event["outcome"] for event in events if event["type"] == "outcome")
    assert outcome["completedFiles"] == 1
    assert outcome["failedFiles"] == 0
    assert outcome["skippedFiles"] == 1
    output_workbook = load_workbook(output / xlsx_path.name)
    assert output_workbook["报名"]["D6"].value == "2026年8月15日"
    output_workbook.close()
    assert not (output / legacy_path.name).exists()
