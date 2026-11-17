# Office Capability Catalog

Prefer these stable skill IDs when composing a zhai work skill.

## General

- `inspect_document`: inspect DOC, DOCX, XLSX, PDF, and text structure without changing originals.
- `merge_xlsx`: align multiple XLSX reports by a single header row and merge their detail rows into one verified XLSX output.
- `redact_content`: create redacted copies and a finding report.
- `citizen_reply`: generate a 12345 reply; requires a configured online model.

## Word

- `apply_redhead`: compose an uploaded DOC/DOCX redhead template or generate one from `unitName`, with a last-page imprint. Upload template alongside body inputs; set `templateName` to its exact original filename. `imprintUnit`, optional `officeName`, `printDate`, and `documentNumber` are independent. See [official-document-format.md](official-document-format.md) for standards and default placeholders. Multi-section or unrecognized templates fail explicitly. Preserve reported missing-font notices in the final reply.
- `docx_to_gongwen`: conservative offline layout for DOC/DOCX. Prefer its parameters: `preserveBold`, `formatTables` (default false; font family only), `applyPageNumbers` (existing footers preserved), `addTitleBlankLine`, `lineSpacingPt`, `titleFont`, `bodyFont`, `firstHeadingFont`, `secondHeadingFont`, `recipientMode` (`auto`/`none`), `signatureMode` (`preserve` by default; `unsigned` only for an explicitly unsealed single-organ document). Never invent missing recipients. Complex sections, letterheads and stamps are preserved with notices, not claimed as fully reformatted.
- `normalize_docx_styles`: normalize document styles while preserving tables and images.
- `doc_to_docx`: convert legacy DOC through a declared adapter when available.
- `word_to_pdf`: export Word to PDF through a verified WPS adapter first, with LibreOffice as an explicit fallback.

## Excel

- `xlsx_recalculate`: recalculate and save a workbook through an available declared adapter.
- `excel_to_pdf`: export workbook pages to PDF through an available declared adapter.

## PDF

- `merge_pdf`, `split_pdf`, `extract_pdf_text`, `redact_pdf`.

## Selection Rules

- Prefer a mature built-in skill over writing equivalent new code.
- Use Python for stable OOXML/XLSX/PDF transformations that do not require office rendering.
- Treat DOC/WPS conversion and high-fidelity PDF export as adapter capabilities, not pure Python features.
- If a capability is unavailable, preserve the package as `unavailable`; never silently pretend it ran.
