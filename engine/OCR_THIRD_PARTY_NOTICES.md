# zhai offline OCR component

This component uses RapidOCR 3.10.0 (Apache-2.0) with ONNX Runtime CPU 1.23.2
(MIT). Original licenses are included in the corresponding distribution metadata
and package data inside the component.

## OCR models

The three bundled models are derived from official PaddleOCR models, copyright
Baidu and/or the respective PaddleOCR rights holders, under Apache-2.0. RapidOCR
redistributes the ONNX conversions under the same terms; see its bundled
`MODEL_LICENSES.md` for upstream attribution and conversion information.

- `PP-OCRv6_det_small.onnx`: SHA-256 `090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f`
- `PP-OCRv6_rec_small.onnx`: SHA-256 `6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884`
- `ch_ppocr_mobile_v2.0_cls_mobile.onnx`: SHA-256 `e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c`

Sources: https://github.com/RapidAI/RapidOCR/tree/v3.10.0
and https://github.com/PaddlePaddle/PaddleOCR.
Weights come directly from the verified RapidOCR 3.10.0 wheel; zhai does not
download models during document processing or supply a network fallback.

## Runtime dependencies

- ONNX Runtime: https://github.com/microsoft/onnxruntime (MIT; bundled notices cover its dependencies)
- OpenCV: https://github.com/opencv/opencv (Apache-2.0; binary distribution carries third-party notices)
- NumPy: https://numpy.org (BSD-3-Clause; bundled license covers included numerical libraries)
- Shapely / GEOS: https://github.com/shapely/shapely (BSD-3-Clause / LGPL-2.1-or-later; original notices included)
- Pillow: https://python-pillow.org (HPND and bundled dependency notices)
- pypdfium2 / PDFium: https://github.com/pypdfium2-team/pypdfium2 (Apache-2.0 or BSD-3-Clause wrapper; PDFium BSD-style and dependency notices)
- pyclipper / Clipper: https://github.com/fonttools/pyclipper (MIT and Boost Software License)
- OmegaConf: https://github.com/omry/omegaconf (BSD-3-Clause)
- PyYAML: https://pyyaml.org (MIT)

This index is supplementary. The original complete license files and notices
collected from the installed distributions govern their respective components.
RapidTable, PdfCraft, Filee, GPU runtimes and unrelated model weights are not
included in this OCR component.
