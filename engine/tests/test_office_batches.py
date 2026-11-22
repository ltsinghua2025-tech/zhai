import hashlib
import sys
from pathlib import Path
from zipfile import ZipFile

from docx import Document
from openpyxl import Workbook, load_workbook
from PIL import Image
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import material_workshop_engine as engine


def execute(tmp_path, op, files):
    before = [hashlib.sha256(f.read_bytes()).digest() for f in files]
    result = engine.run({
        "jobId": op, "files": [{"id": str(index), "path": str(f), "name": f.name} for index, f in enumerate(files)],
        "operations": [{"kind": op}], "outputDirectory": str(tmp_path / "out"), "reportDirectory": str(tmp_path / "reports"),
    })
    assert before == [hashlib.sha256(f.read_bytes()).digest() for f in files]
    return result


def test_read_full_body_and_tables_in_order(tmp_path):
    path = tmp_path / "读取.docx"
    doc = Document()
    doc.add_paragraph("开头" * 12_000)
    table = doc.add_table(rows=1, cols=2)
    table.cell(0, 0).text, table.cell(0, 1).text = "甲", "乙"
    doc.add_paragraph("结尾")
    doc.save(path)
    outcome = execute(tmp_path, "extract_docx_text", [path])
    [output] = outcome["outputs"]
    assert Path(output["path"]).read_text(encoding="utf-8-sig") == "开头" * 12_000 + "\n甲\t乙\n结尾\n"


def test_merge_selected_order_tables_images_and_batch_split(tmp_path):
    icon = tmp_path / "icon.png"
    Image.new("RGB", (10, 10), "red").save(icon)
    first, second = tmp_path / "Z.docx", tmp_path / "A.docx"
    doc = Document()
    doc.add_heading("第一份", 1)
    doc.add_picture(str(icon))
    doc.save(first)
    doc = Document()
    doc.add_heading("第二份", 1)
    doc.add_paragraph().add_run("正文").bold = True
    doc.add_table(rows=1, cols=1).cell(0,0).text = "保留表"
    doc.save(second)
    [merged] = execute(tmp_path, "merge_docx", [first, second])["outputs"]
    path = Path(merged["path"])
    document = Document(path)
    assert [p.text for p in document.paragraphs if p.text.strip()] == ["第一份", "第二份", "正文"]
    assert document.paragraphs[-1].runs[0].bold
    assert len(document.inline_shapes) == 1 and document.tables[0].cell(0, 0).text == "保留表"
    assert document.element.body.xpath('.//w:br[@w:type="page"]')
    outputs = execute(tmp_path, "split_docx", [path])["outputs"]
    first_part, second_part = [Path(o["path"]) for o in outputs]
    assert len(Document(first_part).inline_shapes) == 1
    assert not Document(first_part).element.body.xpath('.//w:br[@w:type="page"]')
    assert Document(second_part).paragraphs[-1].runs[0].bold
    assert Document(second_part).tables[0].cell(0, 0).text == "保留表"
    with ZipFile(second_part) as archive:
        assert not any(n.startswith("word/media/") for n in archive.namelist())


def test_split_skips_pagination_only_preface_and_keeps_break_with_content(tmp_path):
    from docx.enum.text import WD_BREAK

    path = tmp_path / "正文.docx"
    doc = Document()
    doc.add_page_break()
    doc.add_heading("第一章", 1)
    doc.add_paragraph("带内容的段落").add_run().add_break(WD_BREAK.PAGE)
    doc.add_heading("第二章", 1)
    doc.add_page_break()
    doc.save(path)
    first, second = [Path(item["path"]) for item in execute(tmp_path, "split_docx", [path])["outputs"]]
    assert first.name == "正文-01-第一章.docx" and second.name == "正文-02-第二章.docx"
    assert Document(first).paragraphs[-1].text.startswith("带内容的段落")
    assert Document(first).element.body.xpath('.//w:br[@w:type="page"]')
    assert Document(second).element.body.xpath('.//w:br[@w:type="page"]')


def test_split_preface_and_custom_heading(tmp_path):
    from docx.enum.style import WD_STYLE_TYPE

    doc = Document()
    doc.add_paragraph("标题前的表格如下")
    doc.add_table(rows=1,cols=1).cell(0,0).text = "序"
    style = doc.styles.add_style("自定义一级", WD_STYLE_TYPE.PARAGRAPH)
    style.base_style = doc.styles["Heading 1"]
    for text in ("同名", "同名"):
        doc.add_paragraph(text, style)
    path = tmp_path / "章节.docx"
    doc.save(path)
    outputs = execute(tmp_path, "split_docx", [path])["outputs"]
    assert [Path(o["path"]).name for o in outputs] == ["章节-01-前言.docx", "章节-02-同名.docx", "章节-03-同名.docx"]
    assert Document(outputs[0]["path"]).tables[0].cell(0,0).text == "序"


def test_no_partial_or_damaged_word_output(tmp_path):
    path = tmp_path / "无标题.docx"
    doc = Document()
    doc.add_paragraph("内容")
    doc.save(path)
    result = execute(tmp_path, "split_docx", [path])
    assert result["status"] == "failed" and not list((tmp_path / "out").iterdir())
    second = tmp_path / "页眉.docx"
    doc.sections[0].header.paragraphs[0].text = "页眉"
    doc.save(second)
    result = execute(tmp_path, "merge_docx", [path, second])
    assert result["status"] == "failed" and "页眉" in result["failures"][0]["message"]
    assert not list((tmp_path / "out").iterdir())


def test_xlsx_worksheet_per_file_preserves_style_formula_merged_cells(tmp_path):
    from openpyxl.styles import Font

    source = tmp_path / "表格.xlsx"
    wb = Workbook()
    first = wb.active
    first.title = "数据一"
    first["A1"] = 3
    first["B2"] = "=A1*2"
    first["A1"].font = Font(bold=True)
    first.merge_cells("A3:C3")
    first["A3"] = "合并行"
    wb.create_sheet("数据二")["A1"] = "独立"
    wb.save(source)
    out = execute(tmp_path, "split_xlsx", [source])["outputs"]
    one, two = [load_workbook(o["path"]) for o in out]
    assert one.sheetnames == ["数据一"] and two.sheetnames == ["数据二"]
    assert one.active["A1"].value == 3 and one.active["A1"].font.bold
    assert one.active["B2"].value == "=A1*2" and str(one.active.merged_cells) == "A3:C3"
    assert two.active["A1"].value == "独立"
    one.close()
    two.close()


@pytest.mark.parametrize("formula", ["='另一张'!A1", '=INDIRECT("另一张!A1")'])
def test_xlsx_cross_sheet_formulas_fail_without_files(tmp_path, formula):
    wb = Workbook()
    wb.active["A1"] = 12
    wb.active["C2"] = formula
    wb.create_sheet("另一张")["A1"] = 34
    source = tmp_path / "引用.xlsx"
    wb.save(source)
    result = execute(tmp_path, "split_xlsx", [source])
    assert result["status"] == "failed" and not list((tmp_path / "out").iterdir())


def test_read_xlsx_visible_sheets_in_order_with_formulas_and_dates(tmp_path):
    import csv
    from datetime import datetime

    wb = Workbook()
    wb.active.title = "第一页"
    wb.active.append(["甲\t乙", 12, None, "=B1+2"])
    wb.active.append([datetime(2026, 11, 23, 10, 5)])
    hidden = wb.create_sheet("隐藏页")
    hidden.sheet_state = "hidden"
    hidden["A1"] = "隐藏内容"
    wb.create_sheet("空表")
    wb.create_sheet("末页")["A1"] = "最后"
    path = tmp_path / "评审表.xlsx"
    wb.save(path)
    [result] = execute(tmp_path, "extract_xlsx_text", [path])["outputs"]
    target = Path(result["path"])
    assert target.name == "评审表-工作表.txt" and target.read_bytes().startswith(b"\xef\xbb\xbf")
    with target.open(encoding="utf-8-sig", newline="") as stream:
        assert list(csv.reader(stream, delimiter="\t")) == [
            ["[第一页]"], ["甲\t乙", "12", "", "=B1+2"], ["2026-11-23 10:05:00"], [],
            ["[空表]"], ["（空工作表）"], [], ["[末页]"], ["最后"],
        ]


def test_read_sparse_xlsx_ignores_formatted_extent_and_handles_far_cell(tmp_path):
    from openpyxl.styles import Font

    wb = Workbook()
    sheet = wb.active
    sheet["A1"] = "开始"
    sheet["XFD1048575"] = "远处"
    sheet["XFD1048576"].font = Font(bold=True)
    source = tmp_path / "大范围.xlsx"
    wb.save(source)
    [result] = execute(tmp_path, "extract_xlsx_text", [source])["outputs"]
    assert Path(result["path"]).read_text(encoding="utf-8-sig") == "[Sheet]\n开始\nXFD1048575\t远处\n"
