"""Exercise final delivery, mixed-page OCR and composed PDF actions via run()."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

import pytest
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import material_workshop_engine as engine


def fixture_pdf(path, texts):
    document = canvas.Canvas(str(path), pagesize=(300, 400))
    for text in texts:
        if text:
            document.drawString(25, 350, text)
        document.showPage()
    document.save()
    return path


def request(tmp_path, paths, operations):
    return {
        'jobId': 'pdf-pipeline',
        'files': [{'id': path.name, 'name': path.name, 'path': str(path), 'extension': 'pdf'} for path in paths],
        'outputDirectory': str(tmp_path / 'output'),
        'reportDirectory': str(tmp_path / 'reports'),
        'operations': [{'kind': value} if isinstance(value, str) else value for value in operations],
    }


def fake_ocr(monkeypatch, payload=None, *, code=0, expected_pages=1):
    calls = []
    monkeypatch.setenv('MATERIAL_WORKSHOP_VISION_OCR', '/mock/vision-ocr')
    def run(args, **kwargs):
        subset = Path(args[args.index('--input') + 1])
        assert len(PdfReader(subset).pages) == expected_pages
        calls.append(subset)
        value = payload if payload is not None else {'pages': [{'page': index + 1, 'averageConfidence': .91, 'lines': [{'text': f'SCAN-{index + 1}'}]} for index in range(expected_pages)]}
        return subprocess.CompletedProcess(args, code, value if isinstance(value, str) else json.dumps(value), 'OCR failure' if code else '')
    monkeypatch.setattr(engine.subprocess, 'run', run)
    return calls


def run_unchanged(job):
    before = {item['path']: hashlib.sha256(Path(item['path']).read_bytes()).hexdigest() for item in job['files']}
    result = engine.run(job)
    assert before == {path: hashlib.sha256(Path(path).read_bytes()).hexdigest() for path in before}
    return result


def test_ocr_mixed_document_only_recognizes_missing_pages_and_delivers_text(tmp_path, monkeypatch):
    source = fixture_pdf(tmp_path / 'mixed.pdf', ['TEXT-FIRST', '', 'TEXT-LAST', ''])
    calls = fake_ocr(monkeypatch, expected_pages=2)
    result = run_unchanged(request(tmp_path, [source], ['ocr_pdf']))
    assert result['status'] == 'completed'
    assert len(result['outputs']) == 1
    output = Path(result['outputs'][0]['path'])
    assert output.name == 'mixed.ocr.txt'
    assert list((tmp_path / 'output').iterdir()) == [output]
    text = output.read_text(encoding='utf-8')
    assert text.index('TEXT-FIRST') < text.index('SCAN-1') < text.index('TEXT-LAST') < text.index('SCAN-2')
    assert '第 4 页 · OCR 平均置信度 0.910' in text
    assert len(calls) == 1 and not calls[0].exists()


def test_ocr_text_pdf_needs_no_native_engine(tmp_path, monkeypatch):
    monkeypatch.delenv('MATERIAL_WORKSHOP_VISION_OCR', raising=False)
    source = fixture_pdf(tmp_path / 'text.pdf', ['TEXT'])
    result = run_unchanged(request(tmp_path, [source], ['ocr_pdf']))
    assert result['status'] == 'completed'
    assert 'TEXT' in Path(result['outputs'][0]['path']).read_text(encoding='utf-8')


def test_structured_review_uses_same_mixed_page_mapping(tmp_path, monkeypatch):
    source = fixture_pdf(tmp_path / 'mixed.pdf', ['FIRST', '', 'LAST'])
    calls = fake_ocr(monkeypatch)
    result = engine.extract_structured_file({'id': 'mixed', 'path': str(source)})
    assert [(item['locator']['page'], item['text']) for item in result] == [(1, 'FIRST'), (2, 'SCAN-1'), (3, 'LAST')]
    assert len(calls) == 1


def test_review_ocr_legacy_option_delivers_text(tmp_path, monkeypatch):
    source = fixture_pdf(tmp_path / 'scan.pdf', [''])
    fake_ocr(monkeypatch)
    result = run_unchanged(request(tmp_path, [source], [{'kind': 'review_content', 'parameters': {'ocr': True}}]))
    assert Path(result['outputs'][0]['path']).name == 'scan.ocr.txt'


@pytest.mark.parametrize('payload', [
    '{broken', {}, {'pages': []}, {'pages': None}, {'pages': [None]},
    {'pages': [{'page': 2, 'averageConfidence': .9, 'lines': []}]},
    {'pages': [{'page': True, 'averageConfidence': .9, 'lines': []}]},
    {'pages': [{'page': 1, 'averageConfidence': float('nan'), 'lines': []}]},
    {'pages': [{'page': 1, 'averageConfidence': 2, 'lines': []}]},
    {'pages': [{'page': 1, 'averageConfidence': .9, 'lines': [{'text': 42}]}]},
    {'pages': [{'page': 1, 'averageConfidence': .9, 'lines': []}]},
])
def test_invalid_or_empty_ocr_never_leaves_a_final_file(tmp_path, monkeypatch, payload):
    source = fixture_pdf(tmp_path / 'scan.pdf', [''])
    fake_ocr(monkeypatch, payload)
    result = run_unchanged(request(tmp_path, [source], ['ocr_pdf']))
    assert result['status'] == 'failed' and result['outputs'] == []
    assert list((tmp_path / 'output').iterdir()) == []


@pytest.mark.parametrize('failure', ['missing', 'exit', 'timeout', 'duplicate'])
def test_ocr_runtime_and_page_set_failures_do_not_publish(tmp_path, monkeypatch, failure):
    source = fixture_pdf(tmp_path / 'scan.pdf', ['', ''])
    if failure == 'missing':
        monkeypatch.delenv('MATERIAL_WORKSHOP_VISION_OCR', raising=False)
    else:
        payload = {'pages': [{'page': 1, 'averageConfidence': .9, 'lines': [{'text': 'ONE'}]}] * 2} if failure == 'duplicate' else None
        fake_ocr(monkeypatch, payload, code=1 if failure == 'exit' else 0, expected_pages=2)
        if failure == 'timeout':
            def timeout(*args, **kwargs):
                raise subprocess.TimeoutExpired('vision', 300)
            monkeypatch.setattr(engine.subprocess, 'run', timeout)
    result = run_unchanged(request(tmp_path, [source], ['ocr_pdf']))
    assert result['status'] == 'failed' and not result['outputs']
    assert not list((tmp_path / 'output').iterdir())


def test_text_export_marks_missing_pages_and_rejects_entirely_empty_pdf(tmp_path):
    source = fixture_pdf(tmp_path / 'mixed.pdf', ['FIRST', ''])
    result = run_unchanged(request(tmp_path, [source], ['extract_pdf_text']))
    assert result['status'] == 'completed'
    assert any('未执行 OCR' in note for note in result['outputs'][0]['notes'])
    assert '[未提取到文字，请核对原页]' in Path(result['outputs'][0]['path']).read_text(encoding='utf-8')
    empty = fixture_pdf(tmp_path / 'empty.pdf', [''])
    result = run_unchanged(request(tmp_path, [empty], ['extract_pdf_text']))
    assert result['status'] == 'failed' and not result['outputs']
    assert not (tmp_path / 'output' / 'empty.txt').exists()


def test_pdf_operations_compose_and_reopen_before_delivery(tmp_path):
    source = fixture_pdf(tmp_path / 'multi.pdf', ['FIRST', 'SECOND', 'THIRD'])
    operations = [{'kind': 'split_pdf', 'parameters': {'pages': '3,1'}}, {'kind': 'rotate_pdf', 'parameters': {'degrees': 90}}, {'kind': 'watermark_pdf', 'parameters': {'text': 'STAMP'}}, 'clean_metadata']
    result = run_unchanged(request(tmp_path, [source], operations))
    pdf = PdfReader(result['outputs'][0]['path'])
    assert len(pdf.pages) == 2
    assert ['THIRD' in pdf.pages[0].extract_text(), 'FIRST' in pdf.pages[1].extract_text()] == [True, True]
    assert all(page.rotation == 90 and 'STAMP' in page.extract_text() for page in pdf.pages)
    assert not pdf.metadata
    assert any('处理顺序' in note for note in result['outputs'][0]['notes'])


@pytest.mark.parametrize('operation', ['watermark_pdf', 'clean_metadata', 'redact_content'])
def test_incompatible_text_and_pdf_mutation_is_explicitly_rejected(tmp_path, operation):
    source = fixture_pdf(tmp_path / 'text.pdf', ['FIRST'])
    result = run_unchanged(request(tmp_path, [source], ['ocr_pdf', operation]))
    assert result['status'] == 'failed' and not result['outputs']
    assert not list((tmp_path / 'output').iterdir())


def test_merge_fast_path_writes_only_one_pdf_and_no_per_file_intermediates(tmp_path, monkeypatch):
    paths = [fixture_pdf(tmp_path / f'{name}.pdf', [name]) for name in ['b', 'a']]
    writes = []
    original = engine._write_pdf
    def write(writer, target):
        writes.append(target)
        original(writer, target)
    monkeypatch.setattr(engine, '_write_pdf', write)
    result = run_unchanged(request(tmp_path, paths, ['merge_or_split']))
    assert result['status'] == 'completed' and len(writes) == 1
    assert not list((tmp_path / 'reports' / 'merge-inputs').iterdir())
    pdf = PdfReader(result['outputs'][0]['path'])
    assert [page.extract_text().strip() for page in pdf.pages] == ['a', 'b']


def test_merge_validation_failure_removes_candidate(tmp_path, monkeypatch):
    source = fixture_pdf(tmp_path / 'text.pdf', ['FIRST'])
    monkeypatch.setattr(engine, '_write_pdf', lambda writer, target: target.write_bytes(b'broken'))
    result = run_unchanged(request(tmp_path, [source], ['merge_or_split']))
    assert not result['outputs'] and result['failedFiles']
    assert not list((tmp_path / 'output').iterdir())


def test_merge_and_text_request_is_rejected_before_output(tmp_path):
    source = fixture_pdf(tmp_path / 'text.pdf', ['FIRST'])
    with pytest.raises(ValueError, match='先合并 PDF'):
        run_unchanged(request(tmp_path, [source], ['merge_or_split', 'ocr_pdf']))
    assert not list((tmp_path / 'output').iterdir())


@pytest.mark.parametrize('extra_operations', [[], ['rotate_pdf']])
@pytest.mark.parametrize('metadata', ['relativePath', 'name'])
def test_merge_orders_original_names_not_random_snapshot_paths(tmp_path, extra_operations, metadata):
    first = fixture_pdf(tmp_path / 'ffffffff-ffff-ffff-ffff-ffffffffffff-a.pdf', ['A-FIRST'])
    last = fixture_pdf(tmp_path / '00000000-0000-0000-0000-000000000000-b.pdf', ['B-LAST'])
    job = request(tmp_path, [last, first], ['merge_or_split', *extra_operations])
    for item, label in zip(job['files'], ['b.pdf', 'a.pdf']):
        item[metadata] = label
    result = run_unchanged(job)
    assert result['status'] == 'completed'
    assert [page.extract_text().strip() for page in PdfReader(result['outputs'][0]['path']).pages] == ['A-FIRST', 'B-LAST']


@pytest.mark.parametrize('operations', [
    ['replace_text'], ['rotate_pdf', 'replace_text'],
    ['update_dates'], ['extract_pdf_text', 'normalize_whitespace'],
    ['ocr_pdf', 'remove_line_breaks'], ['future_unknown_pdf_action'],
    ['inspect_document', 'replace_text'], ['rotate_pdf', 'redact_content'],
])
def test_unsupported_pdf_operation_never_silently_succeeds(tmp_path, operations):
    source = fixture_pdf(tmp_path / 'text.pdf', ['FIRST'])
    result = run_unchanged(request(tmp_path, [source], operations))
    assert result['status'] == 'failed' and not result['outputs']
    assert not list((tmp_path / 'output').iterdir())


@pytest.mark.parametrize('processor', [engine.process_pdf, engine.process_pdf_actions])
def test_pdf_processor_direct_calls_reject_unknown_actions(tmp_path, processor):
    source = fixture_pdf(tmp_path / 'text.pdf', ['FIRST'])
    target = tmp_path / 'never.pdf'
    arguments = (source, target, {'replace_text'}, {})
    if processor is engine.process_pdf:
        arguments += ([],)
    with pytest.raises(ValueError, match='PDF 不支持'):
        processor(*arguments)
    assert not target.exists()
