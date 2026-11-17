import hashlib
from pathlib import Path
import sys
from zipfile import ZipFile

import pytest
from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from word_structure import edit_structure, read_structure


def test_locator_edit_preserves_runs_package_and_original(tmp_path):
    source = tmp_path / "original.docx"
    document = Document()
    paragraph = document.add_paragraph()
    paragraph.add_run("保留前文 ").bold = True
    paragraph.add_run("待填").italic = True
    paragraph.add_run(" 后文").underline = True
    table = document.add_table(rows=2, cols=2)
    table.cell(0, 0).merge(table.cell(0, 1)).text = "合并表头"
    table.cell(1, 1).paragraphs[0].add_run("旧值").bold = True
    nested = table.cell(1, 0).add_table(rows=1, cols=1)
    nested.cell(0, 0).text = "嵌套值"
    document.save(source)
    before = source.read_bytes()
    structure = read_structure(source)
    assert len(structure["blocks"][1]["rows"][0]["cells"]) == 1
    assert structure["blocks"][1]["rows"][0]["cells"][0]["columnSpan"] == 2
    output = tmp_path / "result.docx"
    edits = [{"locator":"body/p:0","expected":"保留前文 待填 后文","text":"保留前文 新内容 后文"}, {"locator":"body/t:0/r:1/c:1/p:0","expected":"旧值","text":"新值"}]
    edit_structure(source, output, structure["sourceHash"], edits)
    reopened = Document(output)
    assert reopened.paragraphs[0].text == "保留前文 新内容 后文"
    assert reopened.paragraphs[0].runs[0].bold
    assert reopened.paragraphs[0].runs[1].italic
    assert reopened.paragraphs[0].runs[2].underline
    assert reopened.tables[0].cell(1, 1).paragraphs[0].runs[0].bold
    assert reopened.tables[0].cell(1, 0).tables[0].cell(0, 0).text == "嵌套值"
    assert source.read_bytes() == before
    with ZipFile(source) as original, ZipFile(output) as result:
        for name in original.namelist():
            if name != "word/document.xml": assert original.read(name) == result.read(name)


def test_unsafe_or_stale_or_duplicate_edits_never_create_result(tmp_path):
    source = tmp_path / "original.docx"
    doc = Document()
    paragraph = doc.add_paragraph("含字段")
    field = OxmlElement("w:fldChar")
    field.set(qn("w:fldCharType"), "begin")
    paragraph.runs[0]._r.append(field)
    doc.add_paragraph("正常")
    doc.save(source)
    structure = read_structure(source)
    assert not structure["blocks"][0]["editable"]
    output = tmp_path / "result.docx"
    edit = {"locator":"body/p:1","expected":"正常","text":"修改"}
    for source_hash, edits in [("stale", [edit]), (structure["sourceHash"], [edit, edit]), (structure["sourceHash"], [{**edit,"expected":"不符"}]), (structure["sourceHash"], [{"locator":"body/p:0","expected":"含字段","text":"删除字段"}])]:
        with pytest.raises(ValueError): edit_structure(source, output, source_hash, edits)
        assert not output.exists()
    assert hashlib.sha256(source.read_bytes()).hexdigest() == structure["sourceHash"]


def test_vertical_merge_continuation_is_readable_but_not_editable(tmp_path):
    source = tmp_path / "merged.docx"
    doc = Document()
    table = doc.add_table(rows=2, cols=1)
    table.cell(0, 0).merge(table.cell(1, 0)).text = "纵向合并"
    doc.save(source)
    structure = read_structure(source)
    continuation = structure["blocks"][0]["rows"][1]["cells"][0]
    assert continuation["mergedInto"] == "body/t:0/r:0/c:0"
    assert not continuation["blocks"][0]["editable"]
    with pytest.raises(ValueError): edit_structure(source, tmp_path / "out.docx", structure["sourceHash"], [{"locator":continuation["blocks"][0]["locator"],"expected":"","text":"覆盖"}])


def test_block_controls_are_reported_instead_of_silently_missing(tmp_path):
    source = tmp_path / "controlled.docx"
    doc = Document()
    p = doc.add_paragraph("控件里的文字")._p
    wrapper = OxmlElement("w:sdt")
    content = OxmlElement("w:sdtContent")
    wrapper.append(content)
    p.addprevious(wrapper)
    content.append(p)
    doc.save(source)
    structure = read_structure(source)
    assert structure["blocks"][0]["kind"] == "unsupported"
    assert structure["blocks"][0]["textPreview"] == "控件里的文字"
    assert "不能把未列出的内容当作空值" in structure["notes"][1]
