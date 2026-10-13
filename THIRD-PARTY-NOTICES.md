# Third-Party Notices

Redline bundles, links against, or is derived from the following open-source
components. Each retains its own license; the notices below provide the required
attribution and license references.

## MuPDF

- **License:** AGPL-3.0-or-later
- **Project:** https://mupdf.com / https://github.com/ArtifexSoftware/mupdf
- PDF rendering, page operations, and annotation engine.

## PP-OCRv5 models and pipeline

- **License:** Apache-2.0
- **Project:** https://github.com/PaddlePaddle/PaddleOCR (models)
- **Reference implementation:** https://github.com/RapidAI/RapidOCR
- Vendored ONNX model weights and character dictionaries live under `models/ppocrv5/`.
  The detection / recognition / orientation pipeline in `lib/ocr/` is an independent
  reimplementation of the PaddleOCR / RapidOCR pipeline (DBNet post-processing, CTC
  decoding, orientation classification), not a verbatim copy. The models and
  dictionaries are redistributed under their Apache-2.0 license.

## ONNX Runtime (onnxruntime-node)

- **License:** MIT
- **Project:** https://github.com/microsoft/onnxruntime

## Electron

- **License:** MIT
- **Project:** https://www.electronjs.org

## electron-builder

- **License:** MIT
- **Project:** https://github.com/electron-userland/electron-builder

## electron-updater

- **License:** MIT
- **Project:** https://github.com/electron-userland/electron-builder

## pngjs (test support only)

- **License:** MIT
- **Project:** https://github.com/lukeapage/pngjs
