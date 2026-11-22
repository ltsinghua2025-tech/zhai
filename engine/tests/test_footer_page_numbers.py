import hashlib
import sys
from pathlib import Path
from zipfile import ZipFile

import pytest
from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from material_workshop_engine import process_docx


def char(run, kind):
    node = OxmlElement("w:fldChar")
    node.set(qn("w:fldCharType"), kind)
    run._r.append(node)


def page(paragraph, words=(" PA", "GE \\* ROMAN "), prefix="", suffix=""):
    char(paragraph.add_run(prefix), "begin")
    for word in words:
        instr = OxmlElement("w:instrText")
        instr.set(qn("xml:space"), "preserve")
        instr.text = word
        paragraph.add_run()._r.append(instr)
    char(paragraph.add_run(), "separate")
    paragraph.add_run("VII").italic = True
    end = paragraph.add_run()
    char(end, "end")
    end.add_text(suffix)


def apply(source, output):
    return process_docx(source, output, {"center_docx_page_numbers"}, {}, [])


def test_shared_first_even_mixed_and_decorated_roundtrip(tmp_path):
    doc = Document()
    doc.add_paragraph("保留正文")
    doc.settings.odd_and_even_pages_header_footer = True
    sec = doc.sections[0]
    sec.different_first_page_header_footer = True
    main = sec.footer.paragraphs[0]
    main.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    main.paragraph_format.left_indent = Inches(.5)
    main.add_run("办公室").bold = True
    main.add_run().add_tab()
    page(main)
    even = sec.even_page_footer.paragraphs[0]
    even.add_run("第 ")
    page(even)
    even.add_run(" 页 / 共 ")
    page(even, (" NUMPAGES ",))
    even.add_run(" 页")
    sec.first_page_footer.paragraphs[0].add_run("只有落款")
    doc.add_section(WD_SECTION.NEW_PAGE)
    source, out, again = (tmp_path / f"{n}.docx" for n in ("original", "out", "again"))
    doc.save(source)
    original = hashlib.sha256(source.read_bytes()).digest()
    assert apply(source, out)["changes"] == 3
    assert apply(out, again)["changes"] == 0
    assert hashlib.sha256(source.read_bytes()).digest() == original
    result = Document(out)
    assert result.paragraphs[0].text == "保留正文"
    assert result.sections[1].footer.is_linked_to_previous
    main, number = result.sections[0].footer.paragraphs
    assert main.text == "办公室\t" and main.runs[0].bold
    assert main.alignment == WD_ALIGN_PARAGRAPH.RIGHT and main.paragraph_format.left_indent == Inches(.5)
    assert number.alignment == WD_ALIGN_PARAGRAPH.CENTER and number.paragraph_format.left_indent == 0
    assert number.text == "VII" and any(r.italic for r in number.runs)
    assert "".join(number._p.xpath(".//w:instrText/text()")).strip() == "PAGE \\* ROMAN"
    even, = result.sections[0].even_page_footer.paragraphs
    assert even.alignment == WD_ALIGN_PARAGRAPH.CENTER and even.text == "第 VII 页 / 共 VII 页"
    assert "".join(even._p.xpath(".//w:instrText/text()")).endswith(" NUMPAGES ")
    assert result.sections[0].first_page_footer.paragraphs[0].text == "只有落款"
    with ZipFile(out) as first, ZipFile(again) as second:
        for item in first.namelist():
            if item.startswith("word/footer"):
                assert first.read(item) == second.read(item)


def test_complex_field_in_runs_with_other_text_and_unrelated_field(tmp_path):
    doc = Document()
    p = doc.sections[0].footer.paragraphs[0]
    date = OxmlElement("w:fldSimple")
    date.set(qn("w:instr"), " DATE ")
    p._p.append(date)
    page(p, prefix="原落款", suffix="原后缀")
    source, out = tmp_path / "in.docx", tmp_path / "out.docx"
    doc.save(source)
    apply(source, out)
    original, number = Document(out).sections[0].footer.paragraphs
    assert original.text == "原落款原后缀" and original._p.xpath("./w:fldSimple")[0].get(qn("w:instr")) == " DATE "
    assert number.text == "VII" and number.alignment == WD_ALIGN_PARAGRAPH.CENTER


@pytest.mark.parametrize("layout,question", [("table", "原容器内居中"), ("nested", "保留计算公式")])
def test_ambiguous_fields_need_a_layout_choice(tmp_path, layout, question):
    doc = Document()
    footer = doc.sections[0].footer
    p = footer.paragraphs[0]
    if layout == "table":
        p = footer.add_table(1, 1, Inches(3)).cell(0, 0).paragraphs[0]
    else:
        char(p.add_run(), "begin")
    page(p)
    if layout == "nested":
        char(p.add_run(), "end")
    source, out = tmp_path / "in.docx", tmp_path / "out.docx"
    doc.save(source)
    before = hashlib.sha256(source.read_bytes()).digest()
    with pytest.raises(ValueError, match=question):
        apply(source, out)
    assert not out.exists() and hashlib.sha256(source.read_bytes()).digest() == before


def test_replace_existing_fields_preserves_literals_other_fields_and_original(tmp_path):
    from material_workshop_engine import footer_number_fields

    document = Document()
    document.add_paragraph("第一页保留")
    document.add_page_break()
    document.add_paragraph("第二页保留")
    document.core_properties.author = "资料室"
    section = document.sections[0]
    section.header.paragraphs[0].add_run("内部例会")
    footer = section.footer
    left = footer.paragraphs[0]
    left.alignment = WD_ALIGN_PARAGRAPH.LEFT
    page(left, prefix="落款甲", suffix="留存乙")
    total = OxmlElement("w:fldSimple")
    total.set(qn("w:instr"), " NUMPAGES ")
    left._p.append(total)
    right = footer.add_paragraph()
    right.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    legacy = OxmlElement("w:fldSimple")
    legacy.set(qn("w:instr"), " PAGE ")
    right._p.append(legacy)
    source, output, failed = [tmp_path / name for name in ("原件.docx", "替换.docx", "未替换.docx")]
    document.save(source)
    original = hashlib.sha256(source.read_bytes()).digest()
    with pytest.raises(ValueError, match="多个当前页码"):
        apply(source, failed)
    options = {"center_docx_page_numbers": {"replaceExisting": True}}
    process_docx(source, output, set(options), options, [])
    result = Document(output)
    assert [p.text for p in result.paragraphs] == [p.text for p in document.paragraphs]
    assert result.core_properties.author == "资料室" and result.sections[0].header.paragraphs[0].text == "内部例会"
    footer = result.sections[0].footer
    text, number = footer.paragraphs
    assert text.text == "落款甲留存乙" and text.alignment == WD_ALIGN_PARAGRAPH.LEFT
    assert number.alignment == WD_ALIGN_PARAGRAPH.CENTER
    assert [kind for kind, *_ in footer_number_fields(text._p)] == ["NUMPAGES"]
    assert [kind for kind, *_ in footer_number_fields(number._p)] == ["PAGE"]
    assert len(number._p.xpath("./w:fldSimple")) == 1
    with ZipFile(source) as before, ZipFile(output) as after:
        for path in before.namelist():
            if not path.startswith("word/footer"):
                assert before.read(path) == after.read(path), path
    assert not failed.exists() and hashlib.sha256(source.read_bytes()).digest() == original


def test_replace_existing_rejects_unsafe_field_object(tmp_path):
    doc = Document()
    p = doc.sections[0].footer.paragraphs[0]
    page(p)
    p._p.xpath("./w:r[w:t]")[0].append(OxmlElement("w:drawing"))
    source, output = tmp_path / "原件.docx", tmp_path / "成果.docx"
    doc.save(source)
    options = {"center_docx_page_numbers": {"replaceExisting": True}}
    with pytest.raises(ValueError, match="其他对象"):
        process_docx(source, output, set(options), options, [])
    assert not output.exists()
