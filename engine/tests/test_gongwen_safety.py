import sys
from pathlib import Path

import pytest
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.enum.section import WD_SECTION, WD_ORIENT
from docx.enum.style import WD_STYLE_TYPE
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, Cm

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from material_workshop_engine import format_existing_docx_as_gongwen, process_docx


def format_doc(doc, **params):
    return format_existing_docx_as_gongwen(doc, {'applyPageNumbers': False, 'addTitleBlankLine': False, **params})


def notice(*lines):
    d = Document()
    d.add_paragraph('关于做好材料报送工作的通知')
    for line in lines:
        d.add_paragraph(line)
    return d


def test_default_title_gap_and_body_empty_cleanup_are_idempotent(tmp_path):
    d = notice('第一段正文。', '', '一、工作要求', '', '', '第二段正文。')
    source, first, second = (tmp_path / name for name in ('source.docx', 'first.docx', 'second.docx'))
    d.save(source)
    params = {'normalize_docx_styles': {'preset': 'gongwen'}}
    process_docx(source, first, {'normalize_docx_styles'}, params, [])
    process_docx(first, second, {'normalize_docx_styles'}, params, [])
    paragraphs = [p.text for p in Document(first).paragraphs]
    assert paragraphs == ['关于做好材料报送工作的通知', '', '第一段正文。', '一、工作要求', '第二段正文。']
    assert [p.text for p in Document(second).paragraphs] == paragraphs
    assert [p.text for p in Document(source).paragraphs] == [p.text for p in d.paragraphs]


def test_explicit_no_title_gap_still_works(tmp_path):
    d = notice('正文。')
    source, target = tmp_path / 'source.docx', tmp_path / 'target.docx'
    d.save(source)
    process_docx(source, target, {'normalize_docx_styles'}, {
        'normalize_docx_styles': {'preset': 'gongwen', 'addTitleBlankLine': False}
    }, [])
    assert [p.text for p in Document(target).paragraphs] == ['关于做好材料报送工作的通知', '正文。']


def test_soft_line_breaks_do_not_expand_short_lines(tmp_path):
    d = notice('一、培训时间\n上午9时开始。', '示范区政务服务局\n2026年9月13日')
    d.paragraphs[1].runs[0].bold = True
    original = [p.text for p in d.paragraphs]
    _, notes = format_doc(d)
    path = tmp_path / 'soft-breaks.docx'
    d.save(path)
    reopened = Document(path)
    assert [p.text for p in reopened.paragraphs] == original
    assert all(p.alignment == WD_ALIGN_PARAGRAPH.LEFT for p in reopened.paragraphs[1:])
    assert reopened.paragraphs[1].runs[0].bold
    assert len(reopened.element.xpath('//w:br')) == 2
    assert any('手动换行' in note for note in notes)


@pytest.mark.parametrize('recipient', ['各街道办事处：', '收文单位：', '各镇、街道，各有关单位：', '{{主送单位}}：'])
def test_optional_recipient_is_flush_left(recipient):
    d = notice(recipient, '请于月底前报送材料。')
    format_doc(d)
    assert d.paragraphs[1].paragraph_format.first_line_indent.pt == 0
    assert d.paragraphs[2].paragraph_format.first_line_indent.pt == 32


@pytest.mark.parametrize('body', ['现通知如下：', '说明：', '请于月底前报送材料。', '2026年9月30日前完成报送。'])
def test_absent_recipient_does_not_create_or_misidentify(body):
    d = notice(body, '请认真落实。')
    original = [p.text for p in d.paragraphs]
    format_doc(d)
    assert [p.text for p in d.paragraphs] == original
    assert d.paragraphs[1].paragraph_format.first_line_indent.pt == 32


def test_multiline_recipient_and_explicit_none():
    d = notice('各街道办事处、', '各有关单位：', '请认真落实。')
    format_doc(d)
    assert all(p.paragraph_format.first_line_indent.pt == 0 for p in d.paragraphs[1:3])
    d = notice('各单位：', '请认真落实。')
    before = d.paragraphs[1]._p.xml
    format_doc(d, recipientMode='none')
    assert d.paragraphs[1]._p.xml == before  # contradictory candidate is protected, not reclassified


@pytest.mark.parametrize('value', ['2026年9月15日', '202x年x月x日', '{{成文日期}}'])
def test_unsigned_signature_has_gap_and_is_idempotent(value):
    d = notice('请认真落实。', '示范区财政局', value)
    format_doc(d, signatureMode='unsigned')
    sig, date = d.paragraphs[-2:]
    assert sig.paragraph_format.space_before.pt == 28
    assert sig.paragraph_format.keep_with_next
    assert date.alignment == WD_ALIGN_PARAGRAPH.RIGHT
    width = sum(0.5 if c.isascii() else 1 for c in value) * 16
    org_width = len(sig.text.strip()) * 16
    assert date.paragraph_format.right_indent.pt == (32 if width > org_width else org_width - width)
    xml = d._element.xml
    styles = d.styles.element.xml
    format_doc(d, signatureMode='unsigned')
    assert d._element.xml == xml
    assert d.styles.element.xml == styles


def test_unknown_signature_mode_preserves_layout():
    d = notice('请认真落实。', '示范区财政局', '2026年9月15日')
    for p in d.paragraphs[-2:]:
        p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        p.paragraph_format.right_indent = Pt(64)
    before = [p._p.xml for p in d.paragraphs[-2:]]
    _, notes = format_doc(d)
    assert before == [p._p.xml for p in d.paragraphs[-2:]]
    assert any('落款' in n and '保留' in n for n in notes)


def test_joint_signature_not_collapsed_to_single_organ():
    d = notice('请落实。', '示范区财政局', '示范区民政局', '2026年9月15日')
    before = [p._p.xml for p in d.paragraphs[-3:]]
    _, notes = format_doc(d, signatureMode='unsigned')
    assert before == [p._p.xml for p in d.paragraphs[-3:]]
    assert any('联合' in n for n in notes)


def test_inherited_character_indent_and_bold():
    d = notice('    正文需要保留加粗。')
    s = d.styles.add_style('Legacy', WD_STYLE_TYPE.PARAGRAPH)
    s.font.bold = True
    s.element.get_or_add_pPr().get_or_add_ind().set(qn('w:firstLineChars'), '500')
    d.paragraphs[1].style = s
    original_style = s.element.xml
    format_doc(d)
    p = d.paragraphs[1]
    assert p.text == '正文需要保留加粗。'
    assert p.paragraph_format.first_line_indent.pt == 32
    assert p.runs[0].bold is True
    assert not p.style.element.xpath('./w:pPr/w:ind')
    assert s.element.xml == original_style


def test_unnumbered_attachment_and_list_paragraph():
    d = notice('1.请于月底前报送相关材料，并核对统计数据。', '附件：较长的材料名称' * 1)
    format_doc(d)
    p = d.paragraphs[-1]
    assert p.paragraph_format.first_line_indent.pt < 0
    assert p.paragraph_format.left_indent.pt + p.paragraph_format.first_line_indent.pt == 32
    assert not d.paragraphs[1].paragraph_format.keep_with_next


def test_existing_footer_and_page_fields_preserved():
    d = notice('请落实。')
    d.sections[0].footer.paragraphs[0].text = '内部演示 请勿外传'
    before = d.sections[0].footer._element.xml
    _, notes = format_doc(d, applyPageNumbers=True)
    assert d.sections[0].footer._element.xml == before
    assert any('页脚' in n for n in notes)


def test_new_page_numbers_idempotent():
    d = notice('请落实。')
    format_doc(d, applyPageNumbers=True)
    first = [s.footer._element.xml + s.even_page_footer._element.xml for s in d.sections]
    format_doc(d, applyPageNumbers=True)
    assert first == [s.footer._element.xml + s.even_page_footer._element.xml for s in d.sections]


def test_multisection_keeps_landscape_and_contents():
    d = notice('请落实。')
    sec = d.add_section(WD_SECTION.NEW_PAGE)
    sec.orientation = WD_ORIENT.LANDSCAPE
    sec.page_width, sec.page_height = Cm(29.7), Cm(21)
    d.add_paragraph('附件内容')
    before = d._element.xml
    _, notes = format_doc(d)
    assert d._element.xml == before
    assert any('多节' in n for n in notes)


def test_redhead_document_is_protected():
    from docx.shared import RGBColor
    d = Document()
    d.add_paragraph('示范区财政局文件').runs[0].font.color.rgb = RGBColor(255, 0, 0)
    d.add_paragraph('关于做好材料报送工作的通知')
    d.add_paragraph('请落实。')
    before = d._element.xml
    _, notes = format_doc(d)
    assert d._element.xml == before
    assert any('红头' in n for n in notes)


def test_tables_default_preserve_and_explicit_format_is_safe():
    d = notice('请落实。')
    t = d.add_table(rows=1, cols=1)
    t.cell(0, 0).text = '预算380000元'
    t.cell(0, 0).paragraphs[0].runs[0].font.size = Pt(10)
    before = t._tbl.xml
    format_doc(d)
    assert t._tbl.xml == before
    format_doc(d, formatTables=True)
    assert t.cell(0, 0).paragraphs[0].runs[0].font.size.pt == 10
    assert t.cell(0, 0).text == '预算380000元'


@pytest.mark.parametrize('kind', ['picture', 'pagebreak', 'bookmark', 'field', 'section'])
def test_blank_cleanup_preserves_structural_paragraphs(tmp_path, kind):
    d = notice('正文。')
    p = d.add_paragraph()
    if kind == 'pagebreak':
        p.add_run().add_break(WD_BREAK.PAGE)
    elif kind == 'section':
        p._p.get_or_add_pPr().append(OxmlElement('w:sectPr'))
    else:
        tag = {'picture': 'w:drawing', 'bookmark': 'w:bookmarkStart', 'field': 'w:fldChar'}[kind]
        p.add_run()._r.append(OxmlElement(tag))
    marker = p._p.xml
    source, target = tmp_path / 'source.docx', tmp_path / 'out.docx'
    d.save(source)
    before = source.read_bytes()
    process_docx(source, target, {'normalize_whitespace'}, {'normalize_whitespace': {}}, [])
    assert source.read_bytes() == before
    result = Document(target)
    assert len(result.paragraphs) == 3
    assert result.paragraphs[-1]._p.xml == marker


def test_blank_cleanup_keeps_signature_gap_in_combined_pipeline(tmp_path):
    d = notice('请落实。', '', '示范区财政局', '2026年9月15日')
    source, target = tmp_path / 'source.docx', tmp_path / 'out.docx'
    d.save(source)
    process_docx(source, target, {'normalize_whitespace', 'normalize_docx_styles'}, {
        'normalize_whitespace': {}, 'normalize_docx_styles': {'preset': 'gongwen', 'applyPageNumbers': False}
    }, [])
    assert any(not p.text for p in Document(target).paragraphs[1:])


def test_unrecognized_first_paragraph_not_forced_title():
    d = Document()
    d.add_paragraph('请各单位按照要求报送统计数据。')
    format_doc(d)
    assert d.paragraphs[0].alignment != WD_ALIGN_PARAGRAPH.CENTER


@pytest.mark.parametrize('params', [{'signatureMode': 'guess'}, {'recipientMode': 'yes'}, {'lineSpacingPt': float('nan')}])
def test_invalid_parameters_fail_before_modification(params):
    d = notice('请落实。')
    before = d._element.xml
    with pytest.raises((ValueError, RuntimeError)):
        format_doc(d, **params)
    assert d._element.xml == before


def test_long_attachment_list_does_not_bind_entire_page():
    d = notice('正文。', '附件：1.第一项')
    for i in range(2, 12):
        d.add_paragraph(f'{i}.较长的材料名称')
    format_doc(d)
    assert not any(p.paragraph_format.keep_with_next for p in d.paragraphs[2:])


def test_inherited_numbering_attachment_is_not_flattened():
    d = notice('正文。', '附件：1.第一项')
    s = d.styles.add_style('Auto attachment', WD_STYLE_TYPE.PARAGRAPH)
    s.element.get_or_add_pPr().append(OxmlElement('w:numPr'))
    d.paragraphs[-1].style = s
    before = d.paragraphs[-1]._p.xml
    format_doc(d)
    assert d.paragraphs[-1]._p.xml == before


def test_short_body_request_is_not_signature():
    d = notice('请报送至财政局', '2026年9月15日')
    _, notes = format_doc(d, signatureMode='unsigned')
    assert d.paragraphs[1].paragraph_format.first_line_indent.pt == 32
    assert any('未明确' in n for n in notes)


def test_hyperlinks_and_fields_not_rebuilt(tmp_path):
    from docx.opc.constants import RELATIONSHIP_TYPE as RT
    d = notice('正文。')
    p = d.add_paragraph('附件：')
    link = OxmlElement('w:hyperlink')
    link.set(qn('r:id'), d.part.relate_to('https://example.invalid/demo', RT.HYPERLINK, is_external=True))
    run, text = OxmlElement('w:r'), OxmlElement('w:t')
    text.text = '报送说明'
    run.append(text)
    link.append(run)
    p._p.append(link)
    before = p._p.xml
    src, out = tmp_path / 's.docx', tmp_path / 'o.docx'
    d.save(src)
    process_docx(src, out, {'normalize_docx_styles', 'normalize_whitespace'}, {'normalize_docx_styles': {'preset': 'gongwen'}}, [])
    assert Document(out).paragraphs[-1]._p.xml == before


def test_content_guard_rejects_modified_text_before_publish(tmp_path, monkeypatch):
    import material_workshop_engine as engine
    d = notice('金额380000元。')
    src, out = tmp_path / 's.docx', tmp_path / 'o.docx'
    d.save(src)
    def broken(doc, params):
        doc.paragraphs[-1].text = '金额38000元。'
        return 1, []
    monkeypatch.setattr(engine, 'format_existing_docx_as_gongwen', broken)
    with pytest.raises(RuntimeError, match='完整性'):
        process_docx(src, out, {'normalize_docx_styles'}, {'normalize_docx_styles': {'preset': 'gongwen'}}, [])
    assert not out.exists()


def test_full_format_reopen_and_repeat(tmp_path):
    d = notice('各单位：', '正文。', '附件：1.第一项', '2.第二项', '示范区财政局', '2026年9月15日')
    src, first, second = (tmp_path / x for x in ('s.docx', 'a.docx', 'b.docx'))
    d.save(src)
    params = {'normalize_docx_styles': {'preset': 'gongwen', 'signatureMode': 'unsigned', 'addTitleBlankLine': True}}
    process_docx(src, first, {'normalize_docx_styles'}, params, [])
    process_docx(first, second, {'normalize_docx_styles'}, params, [])
    a, b = Document(first), Document(second)
    assert a._element.xml == b._element.xml
    assert a.styles.element.xml == b.styles.element.xml
