from pathlib import Path
import hashlib
import sys

import pytest
from pypdf import PdfReader, PdfWriter
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import material_workshop_engine as engine


def request_for(tmp_path, broken=False):
    inputs = tmp_path / 'inputs'
    inputs.mkdir()
    files = []
    for name, pages in [('b.pdf', 2), ('a.pdf', 1)]:
        path = inputs / name
        writer = PdfWriter()
        for _ in range(pages):
            writer.add_blank_page(width=100 if name == 'a.pdf' else 200, height=300)
        with path.open('wb') as stream:
            writer.write(stream)
        files.append({'id': name, 'name': name, 'path': str(path), 'extension': 'pdf'})
    if broken:
        Path(files[0]['path']).write_bytes(b'broken PDF')
    return {'jobId': 'merge-test', 'files': files, 'outputDirectory': str(tmp_path / 'output'), 'reportDirectory': str(tmp_path / 'report'), 'operations': [{'kind': 'merge_or_split'}]}


def test_merge_delivers_one_reopened_pdf_in_filename_order(tmp_path):
    request = request_for(tmp_path)
    before = {f['path']: hashlib.sha256(Path(f['path']).read_bytes()).hexdigest() for f in request['files']}
    result = engine.run(request)
    assert result['status'] == 'completed'
    assert len(result['outputs']) == 1
    output = Path(result['outputs'][0]['path'])
    assert output.name == '合并材料.pdf'
    assert list(Path(request['outputDirectory']).iterdir()) == [output]
    pdf = PdfReader(output)
    assert [float(p.mediabox.width) for p in pdf.pages] == [100, 200, 200]
    assert before == {p: hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in before}


@pytest.mark.parametrize('failure', ['input', 'merge'])
def test_merge_never_delivers_partial_or_per_file_copies(tmp_path, monkeypatch, failure):
    request = request_for(tmp_path, broken=failure == 'input')
    if failure == 'merge':
        def reject(*args):
            raise ValueError('merge failed')
        monkeypatch.setattr(engine, 'merge_pdfs', reject)
    result = engine.run(request)
    assert result['failedFiles'] > 0
    assert result['outputs'] == []
