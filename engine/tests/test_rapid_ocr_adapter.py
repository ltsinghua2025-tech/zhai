"""Offline adapter integrity and explicit-environment routing regressions."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest
from pypdf import PdfWriter

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import material_workshop_engine as engine
import rapid_ocr_adapter as adapter


def test_model_integrity_rejects_missing_modified_and_symlink_files(tmp_path, monkeypatch):
    expected = hashlib.sha256(b'model').hexdigest()
    monkeypatch.setattr(adapter, 'MODEL_HASHES', {'model.onnx': expected})
    path = tmp_path / 'model.onnx'
    with pytest.raises(RuntimeError, match='模型缺失'):
        adapter.verify_models(tmp_path)
    path.write_bytes(b'corrupt')
    with pytest.raises(RuntimeError, match='校验失败'):
        adapter.verify_models(tmp_path)
    path.write_bytes(b'model')
    assert adapter.verify_models(tmp_path) == {'model.onnx': str(path)}
    path.unlink()
    real = tmp_path / 'real.onnx'
    real.write_bytes(b'model')
    path.symlink_to(real)
    with pytest.raises(RuntimeError, match='模型缺失'):
        adapter.verify_models(tmp_path)


@pytest.mark.parametrize('texts,scores', [
    (['text'], None), (None, [.9]), (['one', 'two'], [.9]),
    ([123], [.9]), (['one'], [float('nan')]), (['one'], [1.1]),
])
def test_adapter_does_not_serialize_invalid_inference(texts, scores):
    with pytest.raises(RuntimeError):
        adapter.checked_lines(SimpleNamespace(txts=texts, scores=scores))


def test_adapter_empty_and_low_confidence_are_explicit():
    assert adapter.checked_lines(SimpleNamespace(txts=None, scores=None)) == []
    assert adapter.checked_lines(SimpleNamespace(txts=[' uncertain '], scores=[.2])) == [{'text': ' uncertain ', 'confidence': .2}]


def test_adapter_rejects_nonlocal_input_and_unknown_language_before_loading_models(tmp_path):
    with pytest.raises(ValueError, match='绝对路径'):
        adapter.recognize_pdf(Path('https:/example.com/scan.pdf'), ['zh-Hans'])
    source = tmp_path / 'sample.pdf'
    source.write_bytes(b'%PDF')
    with pytest.raises(ValueError, match='只支持简体中文和英文'):
        adapter.recognize_pdf(source, ['unknown'])


@pytest.mark.parametrize('vision', [False, True])
def test_rapid_routing_is_explicit_and_preserves_vision_priority(tmp_path, monkeypatch, vision):
    source = tmp_path / 'scan.pdf'
    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    writer.write(source)
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    monkeypatch.setenv('MATERIAL_WORKSHOP_RAPID_OCR', '/mock/rapid')
    monkeypatch.delenv('MATERIAL_WORKSHOP_VISION_OCR', raising=False)
    if vision:
        monkeypatch.setenv('MATERIAL_WORKSHOP_VISION_OCR', '/mock/vision')
    calls = []
    def run(args, **kwargs):
        calls.append(args)
        payload = {'pages': [{'page': 1, 'averageConfidence': .8, 'lines': [{'text': '已识别内容'}]}]}
        return subprocess.CompletedProcess(args, 0, json.dumps(payload), '')
    monkeypatch.setattr(engine.subprocess, 'run', run)
    result = engine.run({
        'jobId': 'rapid-routing',
        'files': [{'id': 'scan', 'name': source.name, 'path': str(source)}],
        'operations': [{'kind': 'ocr_pdf'}],
        'outputDirectory': str(tmp_path / 'output'),
        'reportDirectory': str(tmp_path / 'reports'),
    })
    assert result['status'] == 'completed'
    assert calls[0][0] == ('/mock/vision' if vision else '/mock/rapid')
    assert len(result['outputs']) == 1
    assert '已识别内容' in Path(result['outputs'][0]['path']).read_text(encoding='utf-8')
    assert hashlib.sha256(source.read_bytes()).hexdigest() == before


def test_plain_extraction_does_not_autodiscover_or_launch_ocr(tmp_path, monkeypatch):
    source = tmp_path / 'scan.pdf'
    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    writer.write(source)
    monkeypatch.delenv('MATERIAL_WORKSHOP_RAPID_OCR', raising=False)
    monkeypatch.delenv('MATERIAL_WORKSHOP_VISION_OCR', raising=False)
    def unexpected(*args, **kwargs):
        pytest.fail('OCR was invoked without an explicit environment')
    monkeypatch.setattr(engine.subprocess, 'run', unexpected)
    assert engine.extract_structured_file({'id': 'scan', 'path': str(source)}) == []
