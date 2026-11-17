from pathlib import Path
import sys
import pytest
from docx import Document
from docx.shared import RGBColor, Pt
from docx.oxml.ns import qn
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import material_workshop_engine as engine
import redhead


@pytest.fixture(autouse=True)
def fonts(monkeypatch):
    monkeypatch.setattr(engine, '_installed_font_families', lambda: '仿宋gb2312楷体gb2312宋体方正小标宋简体黑体timesnewroman')


def body(path):
    doc = Document()
    doc.add_paragraph('关于报送案例的通知')
    doc.add_paragraph('各有关单位：')
    doc.add_paragraph('请于9月25日前报送材料。').runs[0].bold = True
    doc.add_table(rows=1,cols=1).cell(0,0).text = '保留表格'
    doc.save(path)
    return path


def test_generated_redhead_and_imprint_defaults(tmp_path):
    source = body(tmp_path/'body.docx')
    before = engine.checksum(source)
    target = tmp_path/'out.docx'
    result = redhead.compose(source, target, {}, engine)
    doc = Document(target)
    assert '中共珠海市xxx' in [p.text for p in doc.paragraphs]
    assert doc.tables[-1].cell(0,1).text == redhead.DEFAULT_DATE
    assert doc.tables[0].cell(0,0).text == '保留表格'
    assert abs(doc.sections[0].left_margin.mm - 28) < .02
    assert len(doc.element.xpath('.//w:pBdr/w:bottom[@w:color="FF0000"]')) == 1
    assert 'tblpYSpec="bottom"' in doc.tables[-1]._tbl.xml
    assert engine.checksum(source) == before
    assert any('占位' in n for n in result['notes'])


def test_redhead_hides_only_first_page_number_without_restarting_sequence(tmp_path):
    source = body(tmp_path / 'body.docx')
    doc = Document(source)
    for index in range(75):
        doc.add_paragraph(f'第{index + 1}项办理要求：请按程序整理材料并及时报送。')
    doc.save(source)
    target = tmp_path / 'output.docx'
    redhead.compose(source, target, {}, engine)
    reopened = Document(target)
    section = reopened.sections[0]
    assert section.different_first_page_header_footer
    assert 'PAGE' not in section.first_page_footer._element.xml
    assert 'PAGE' in section.footer._element.xml
    assert 'PAGE' in section.even_page_footer._element.xml
    assert not reopened.element.xpath('.//w:pgNumType')


def test_template_first_page_header_and_non_number_footer_text_are_retained(tmp_path):
    template = tmp_path / 'template.docx'
    doc = Document()
    paragraph = doc.add_paragraph('甲单位文件')
    paragraph.runs[0].font.color.rgb = RGBColor(255, 0, 0)
    doc.add_paragraph('{{正文}}')
    doc.sections[0].header.paragraphs[0].text = '保留模板页眉'
    doc.sections[0].footer.paragraphs[0].text = '内部使用'
    doc.save(template)
    source = body(tmp_path / 'body.docx')
    target = tmp_path / 'output.docx'
    redhead.compose(source, target, {'_templatePath': str(template)}, engine)
    reopened = Document(target)
    assert reopened.sections[0].first_page_header.paragraphs[0].text == '保留模板页眉'
    assert reopened.sections[0].first_page_footer.paragraphs[0].text == '内部使用'
    assert 'PAGE' in reopened.sections[0].even_page_footer._element.xml


@pytest.mark.parametrize('params,unit,stamp', [
    ({},redhead.DEFAULT_UNIT,redhead.DEFAULT_DATE),
    ({'unitName':'甲委员会','officeName':'办公室'},'甲委员会办公室',redhead.DEFAULT_DATE),
    ({'unitName':'甲委员会','imprintUnit':'乙办公室','officeName':'办公室','printDate':'2026-09-15'},'乙办公室','2026年9月15日印发'),
])
def test_imprint_values(params,unit,stamp):
    assert redhead.imprint_values(params) == (unit,stamp)


@pytest.mark.parametrize('stamp',['2026年2月30日','今天','2026-13-1'])
def test_invalid_date_not_invented(stamp):
    with pytest.raises(ValueError): redhead.imprint_values({'printDate':stamp})


@pytest.mark.parametrize('prefix', ['', 'aabbccdd-1234-1234-1234-aabbccddeeff-' * 2])
def test_template_redhead_kept_and_template_not_output(tmp_path, prefix):
    template = tmp_path/(prefix+'template.docx')
    doc = Document()
    p = doc.add_paragraph('甲单位文件'); p.runs[0].font.color.rgb = RGBColor(255,0,0); p.runs[0].font.size=Pt(36)
    redhead._border(p,color='FF0000')
    doc.add_paragraph('{{正文}}')
    doc.add_paragraph('这是模板示例正文，应移除')
    doc.save(template)
    source = body(tmp_path/'body.docx')
    inputs = [template,source]
    before = [engine.checksum(p) for p in inputs]
    result = engine.run({'jobId':'test','files':[{'id':str(i),'name':p.name,'path':str(p),'extension':'docx'} for i,p in enumerate(inputs)], 'operations':[{'kind':'apply_redhead','parameters':{'templateName':'template.docx'}}], 'outputDirectory':str(tmp_path/'out'),'reportDirectory':str(tmp_path/'report')})
    assert result['failedFiles'] == 0
    assert len(result['outputs']) == 1
    doc=Document(result['outputs'][0]['path'])
    assert doc.paragraphs[0].text == '甲单位文件'
    assert doc.paragraphs[0].runs[0].font.size.pt == 36
    assert '示例正文' not in doc.element.xml
    assert before == [engine.checksum(p) for p in inputs]


def test_unknown_template_does_not_read_arbitrary_path(tmp_path):
    p=body(tmp_path/'b.docx')
    with pytest.raises(ValueError,match='精确匹配'):
        engine.run({'jobId':'test','files':[{'id':'1','name':p.name,'path':str(p)}], 'operations':[{'kind':'apply_redhead','parameters':{'templateName':'/etc/passwd'}}], 'outputDirectory':str(tmp_path/'out'),'reportDirectory':str(tmp_path/'report')})


def test_missing_font_reaches_outcome(tmp_path):
    p=body(tmp_path/'body.docx')
    result=engine.run({'jobId':'fonts','files':[{'id':'1','name':p.name,'path':str(p),'extension':'docx'}], 'operations':[{'kind':'normalize_docx_styles','parameters':{'preset':'gongwen','bodyFont':'不存在的测试字体'}}], 'outputDirectory':str(tmp_path/'out'),'reportDirectory':str(tmp_path/'report')})
    notes=' '.join(result['outputs'][0]['notes'])
    assert '不存在的测试字体' in notes
    assert '实际替代字体尚未确认' in notes


def test_font_inspection_includes_used_style_ancestors_not_unused(tmp_path):
    from docx.enum.style import WD_STYLE_TYPE
    doc=Document()
    parent=doc.styles.add_style('UsedParent', WD_STYLE_TYPE.PARAGRAPH)
    parent.font.name='MissingParentFont'
    child=doc.styles.add_style('UsedChild', WD_STYLE_TYPE.PARAGRAPH)
    child.base_style=parent
    unused=doc.styles.add_style('UnusedFontStyle', WD_STYLE_TYPE.PARAGRAPH)
    unused.font.name='UnusedFont'
    doc.add_paragraph('正文', style=child)
    path=tmp_path/'fonts.docx'; doc.save(path)
    names=engine.document_font_names(path)
    assert 'MissingParentFont' in names
    assert 'UnusedFont' not in names


def test_batch_keeps_tables_images_and_originals(tmp_path):
    from base64 import b64decode
    from io import BytesIO
    picture = b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jDBkAAAAASUVORK5CYII=')
    paths = [body(tmp_path/f'body{i}.docx') for i in range(2)]
    for path in paths:
        doc=Document(path); doc.add_picture(BytesIO(picture)); doc.save(path)
    before = [engine.checksum(p) for p in paths]
    result=engine.run({'jobId':'batch','files':[{'id':str(i),'name':p.name,'path':str(p),'extension':'docx'} for i,p in enumerate(paths)],'operations':[{'kind':'apply_redhead','parameters':{'unitName':'测试单位','printDate':'2026年9月15日'}}], 'outputDirectory':str(tmp_path/'out'),'reportDirectory':str(tmp_path/'report')})
    assert result['failedFiles'] == 0
    assert len(result['outputs']) == 2
    for output in result['outputs']:
        doc=Document(output['path'])
        assert len(doc.inline_shapes) == 1
        assert doc.tables[0].cell(0,0).text == '保留表格'
    assert before == [engine.checksum(p) for p in paths]
