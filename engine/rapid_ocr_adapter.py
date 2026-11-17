#!/usr/bin/env python3
"""Offline OCR component. Kept out of the general-purpose file engine bundle."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import time

if sys.platform.startswith("linux"):
    os.environ.setdefault("OPENSSL_armcap", "0")

MODEL_HASHES = {
    "PP-OCRv6_det_small.onnx": "090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f",
    "PP-OCRv6_rec_small.onnx": "6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884",
    "ch_ppocr_mobile_v2.0_cls_mobile.onnx": "e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c",
}
LANGUAGES = {"zh-Hans", "en-US"}


def verify_models(directory: Path) -> dict[str, str]:
    paths = {}
    for name, expected in MODEL_HASHES.items():
        path = directory / name
        if not path.is_file() or path.is_symlink():
            raise RuntimeError(f"离线 OCR 模型缺失：{name}；请重新安装完整组件，不会联网下载")
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        if digest.hexdigest() != expected:
            raise RuntimeError(f"离线 OCR 模型校验失败：{name}；不会联网替换")
        paths[name] = str(path)
    return paths


def create_engine():
    import rapidocr
    from rapidocr import RapidOCR

    paths = verify_models(Path(rapidocr.__file__).resolve().parent / "models")
    # Explicit paths bypass RapidOCR's automatic download branch. No user URLs,
    # custom model directories, GPU providers or network fallback are accepted.
    return RapidOCR(params={
        "Det.model_path": paths["PP-OCRv6_det_small.onnx"],
        "Cls.model_path": paths["ch_ppocr_mobile_v2.0_cls_mobile.onnx"],
        "Rec.model_path": paths["PP-OCRv6_rec_small.onnx"],
        "Global.log_level": "warning",
        "Global.text_score": 0.0,
        "EngineConfig.onnxruntime.intra_op_num_threads": 2,
        "EngineConfig.onnxruntime.inter_op_num_threads": 1,
        "EngineConfig.onnxruntime.use_cuda": False,
        "EngineConfig.onnxruntime.use_coreml": False,
    })


def checked_lines(result) -> list[dict]:
    texts = result.txts
    scores = result.scores
    if texts is None and scores is None:
        return []
    if texts is None or scores is None or len(texts) != len(scores):
        raise RuntimeError("OCR 文字与置信度数量不一致")
    lines = []
    for text, confidence in zip(texts, scores):
        if not isinstance(text, str):
            raise RuntimeError("OCR 返回无效文字")
        confidence = float(confidence)
        if not math.isfinite(confidence) or not 0 <= confidence <= 1:
            raise RuntimeError("OCR 返回无效置信度")
        if text.strip():
            lines.append({"text": text, "confidence": confidence})
    return lines


def probe() -> dict:
    from PIL import Image, ImageDraw, ImageFont

    started = time.perf_counter()
    engine = create_engine()
    sample = Image.new("RGB", (320, 100), "white")
    ImageDraw.Draw(sample).text((15, 20), "OCR 123", font=ImageFont.load_default(size=40), fill="black")
    lines = checked_lines(engine(sample))
    normalized = "".join("".join(line["text"] for line in lines).split()).upper()
    if normalized != "OCR123":
        raise RuntimeError("OCR 推理自检文字与预期不符，组件暂不可用")
    return {
        "capabilities": {"ocrPdf": True},
        "provider": "RapidOCR",
        "version": "3.10.0",
        "runtime": "ONNX Runtime CPU 1.23.2",
        "offline": True,
        "modelsVerified": len(MODEL_HASHES),
        "inferenceChecked": True,
        "elapsedSeconds": round(time.perf_counter() - started, 3),
        "languages": sorted(LANGUAGES),
    }


def recognize_pdf(source: Path, languages: list[str]) -> dict:
    if not source.is_absolute() or not source.is_file() or source.suffix.lower() != ".pdf":
        raise ValueError("OCR 输入必须为本地 PDF 文件的绝对路径")
    if not languages or any(language not in LANGUAGES for language in languages):
        raise ValueError("此离线 OCR 组件只支持简体中文和英文（zh-Hans,en-US）")
    import pypdfium2 as pdfium

    engine = create_engine()
    pages = []
    started = time.perf_counter()
    document = pdfium.PdfDocument(str(source))
    try:
        if len(document) == 0:
            raise ValueError("OCR 输入 PDF 没有页面")
        for index in range(len(document)):
            if time.perf_counter() - started > 240:
                raise RuntimeError("OCR 超过 240 秒，未返回不完整结果；请分批处理")
            page = document[index]
            try:
                width, height = page.get_size()
                if not all(math.isfinite(value) and value > 0 for value in (width, height)):
                    raise ValueError(f"第 {index + 1} 页尺寸无效")
                # Bound each raster to 12 MP, while keeping ordinary A4 near 144dpi.
                scale = min(2.0, math.sqrt(12_000_000 / (width * height)), 6000 / max(width, height))
                bitmap = page.render(scale=scale)
                try:
                    lines = checked_lines(engine(bitmap.to_pil()))
                finally:
                    bitmap.close()
            finally:
                page.close()
            average = sum(line["confidence"] for line in lines) / len(lines) if lines else 0.0
            pages.append({"page": index + 1, "averageConfidence": average, "lines": lines})
    finally:
        document.close()
    return {"source": str(source), "languages": languages, "provider": "RapidOCR", "pages": pages}


def main() -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--probe", action="store_true")
    mode.add_argument("--input", type=Path)
    parser.add_argument("--languages", default="zh-Hans,en-US")
    args = parser.parse_args()
    try:
        result = probe() if args.probe else recognize_pdf(args.input, args.languages.split(","))
        print(json.dumps(result, ensure_ascii=False, separators=(",", ":"), allow_nan=False))
        return 0
    except Exception as exc:
        print(f"离线 OCR 失败：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
