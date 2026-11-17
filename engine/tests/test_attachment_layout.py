import sys
from pathlib import Path

from docx import Document
from docx.oxml.ns import qn
from docx.shared import Pt
from docx.enum.style import WD_STYLE_TYPE

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from material_workshop_engine import format_existing_docx_as_gongwen, normalize_gongwen_attachment_lists


def test_attachment_list_clears_mixed_indents_and_preserves_content(tmp_path):
    document = Document()
    document.add_paragraph('测试通知')
    document.add_paragraph('1.正文要求')
    document.add_paragraph('附件：1.第一份材料')
    legacy = document.styles.add_style('Legacy Attachment', WD_STYLE_TYPE.PARAGRAPH)
    legacy.element.get_or_add_pPr().get_or_add_ind().set(qn('w:firstLineChars'), '200')
    document.paragraphs[-1].style = legacy
    p = document.add_paragraph('          2.第二份材料')
    p.paragraph_format.first_line_indent = Pt(32)
    p = document.add_paragraph('3.第三份材料')
    p._p.get_or_add_pPr().get_or_add_ind().set(qn('w:firstLineChars'), '500')
    p.runs[0].bold = True
    document.add_paragraph('')
    document.add_paragraph('4.后续正文')
    format_existing_docx_as_gongwen(document, {'applyPageNumbers': False, 'addTitleBlankLine': False})
    path = tmp_path / 'result.docx'
    document.save(path)
    reopened = Document(path)
    assert [p.text for p in reopened.paragraphs[2:5]] == [
        '附件：1.\t第一份材料', '2.\t第二份材料', '3.\t第三份材料',
    ]
    for index, p in enumerate(reopened.paragraphs[2:5]):
        fmt = p.paragraph_format
        assert fmt.left_indent.pt + fmt.first_line_indent.pt == (32 if index == 0 else 80)
        assert fmt.left_indent.pt == 96  # continuation lines start at the name
        assert fmt.keep_with_next == (index < 2)
        assert fmt.keep_together is True
        assert not any(k.endswith('Chars') for k in p._p.pPr.ind.attrib)
        assert not p.style.element.xpath('./w:pPr/w:ind')
    assert reopened.styles['Legacy Attachment'].element.xpath('./w:pPr/w:ind')
    assert reopened.paragraphs[4].runs[0].bold is True
    assert reopened.paragraphs[1].text == '1.正文要求'
    assert reopened.paragraphs[6].text == '4.后续正文'
    before = reopened._element.xml
    normalize_gongwen_attachment_lists(reopened.paragraphs)
    assert reopened._element.xml == before


def test_attachment_prefix_across_runs_and_list_boundary():
    document = Document()
    p = document.add_paragraph('附')
    p.add_run('件：1.')
    p.add_run('第一项').italic = True
    document.add_paragraph('2.第二项')
    document.add_table(rows=1, cols=1)
    document.add_paragraph('3.表后正文')
    assert normalize_gongwen_attachment_lists(document.paragraphs) == 2
    assert document.paragraphs[0].text == '附件：1.\t第一项'
    assert document.paragraphs[0].runs[-1].italic is True
    assert document.paragraphs[2].text == '3.表后正文'


def test_long_attachment_list_has_room_for_two_digit_numbers():
    document = Document()
    document.add_paragraph('附件：1.第一项')
    for number in range(2, 11):
        document.add_paragraph(f'{number}.较长的材料名称')
    normalize_gongwen_attachment_lists(document.paragraphs)
    assert document.paragraphs[-1].text == '10.\t较长的材料名称'
    assert document.paragraphs[-1].paragraph_format.left_indent.pt == 104
    assert document.paragraphs[-1].paragraph_format.keep_with_next is False
