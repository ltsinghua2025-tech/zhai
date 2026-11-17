# Generated from engine/material_workshop_engine.py.
import re
from typing import Any

def _set_run_font(run: Any, east_asia: str, size_pt: float, bold: bool = False) -> None:
    from docx.oxml.ns import qn
    from docx.shared import Pt

    run.font.name = "Times New Roman"
    run.font.size = Pt(size_pt)
    run.font.bold = bold
    fonts = run._element.get_or_add_rPr().get_or_add_rFonts()  # noqa: SLF001
    fonts.set(qn("w:ascii"), "Times New Roman")
    fonts.set(qn("w:hAnsi"), "Times New Roman")
    fonts.set(qn("w:eastAsia"), east_asia)

def normalize_gongwen_attachment_lists(paragraphs: list[Any], preserve_bold: bool = True) -> int:
    """Align explicit attachment lists without confusing them with body headings.

    Normalize only consecutive numbered items introduced by 附件：1. .  Clear
    character-based indents as well as point indents; Word gives the former
    priority. Replace padding spaces with a tab and hanging indentation so
    wrapped names remain aligned. Unrelated numbered paragraphs stay untouched.
    """
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.enum.style import WD_STYLE_TYPE
    from docx.oxml.ns import qn
    from docx.shared import Pt
    from copy import deepcopy
    from gongwen_layout import complex_paragraph

    def remove_inherited_indent(paragraph: Any) -> None:
        # Merely deleting direct firstLineChars leaves the same attribute in
        # Normal Indent (or another base style) active. Flatten this paragraph's
        # style into a private derivative, preserving the other style settings.
        original = paragraph.style
        styles = paragraph.part.document.styles
        name = "zhai附件说明-" + original.style_id
        if original.name.startswith("zhai附件说明-"):
            return
        if name not in styles:
            derived = styles.add_style(name, WD_STYLE_TYPE.PARAGRAPH)
            chain = []
            seen = set()
            current = original
            while current is not None and current.style_id not in seen:
                seen.add(current.style_id)
                chain.append(current)
                current = current.base_style
            for source_style in reversed(chain):
                for part in ('pPr', 'rPr'):
                    source = source_style.element.find(qn('w:' + part))
                    if source is None:
                        continue
                    destination = getattr(derived.element, 'get_or_add_' + part)()
                    for child in source:
                        if part == 'pPr' and child.tag in (qn('w:ind'), qn('w:tabs'), qn('w:numPr')):
                            continue
                        existing = destination.find(child.tag)
                        if existing is not None:
                            destination.remove(existing)
                        destination.append(deepcopy(child))
        paragraph.style = styles[name]

    first_pattern = re.compile(r"^\s*(附件\s*[：:]\s*)(1)([.．、])[ \t\u3000]*(?=\S)")
    next_pattern = re.compile(r"^[ \t\u3000]*(\d{1,3})([.．、])[ \t\u3000]*(?=\S)")
    changed = 0
    index = 0
    while index < len(paragraphs):
        first = first_pattern.match(paragraphs[index].text)
        if first is None:
            index += 1
            continue
        items = [(paragraphs[index], first, "附件" + first.group(1).strip()[-1] + "1" + first.group(3))]
        end = index + 1
        while end < len(paragraphs):
            paragraph = paragraphs[end]
            if paragraphs[end - 1]._p.getnext() is not paragraph._p:
                break
            match = next_pattern.match(paragraph.text)
            if match is None or int(match.group(1)) != len(items) + 1:
                break
            items.append((paragraph, match, match.group(1) + match.group(2)))
            end += 1
        # Fields, links, automatic numbering and manual line breaks need their
        # own structural handling. Do not flatten them to fix a plain-text list.
        if any(
            complex_paragraph(p) or "\n" in p.text or p._p.xpath('./w:pPr/w:numPr')
            or ''.join(r.text for r in p.runs) != p.text
            or p._p.xpath('.//w:drawing | .//w:pict | .//w:fldChar')
            for p, _, _ in items
        ):
            index = end
            continue
        name_offset = 80 + max(16, (len(str(len(items))) + 1) * 8)
        for position, (paragraph, match, prefix) in enumerate(items):
            remove_inherited_indent(paragraph)
            # Remove only the old prefix, retaining all content runs and styles.
            remaining = match.end()
            inserted = False
            for run in paragraph.runs:
                if remaining <= 0:
                    break
                old = run.text
                consumed = min(remaining, len(old))
                run.text = (prefix + "\t" if not inserted else "") + old[consumed:]
                inserted = True
                remaining -= consumed
            ppr = paragraph._p.get_or_add_pPr()
            for ind in list(ppr.findall(qn("w:ind"))):
                ppr.remove(ind)
            for tabs in list(ppr.findall(qn("w:tabs"))):
                ppr.remove(tabs)
            fmt = paragraph.paragraph_format
            fmt.left_indent = Pt(name_offset)
            fmt.right_indent = Pt(0)
            fmt.first_line_indent = Pt((32 if position == 0 else 80) - name_offset)
            fmt.tab_stops.add_tab_stop(Pt(name_offset))
            fmt.keep_together = len(paragraph.text) <= 120
            fmt.keep_with_next = (len(items) <= 4 and sum(len(p.text) for p, _, _ in items) <= 240 and position < len(items) - 1)
            paragraph.alignment = WD_ALIGN_PARAGRAPH.LEFT
            if not preserve_bold:
                for run in paragraph.runs:
                    run.bold = False
            changed += 1
        index = end
    return changed

def format_existing_docx_as_gongwen(
    document: Any,
    parameters: dict[str, Any] | None = None,
) -> tuple[int, list[str]]:
    from gongwen_layout import apply_layout
    # Font notices are collected from the saved package by process_file,
    # including inherited styles, headers and WordArt, not a second partial scan.
    return apply_layout(document, parameters, _set_run_font, normalize_gongwen_attachment_lists)

def clear_docx_metadata(document: Any) -> None:
    properties = document.core_properties
    properties.author = ""
    properties.last_modified_by = ""
    properties.comments = ""
    properties.keywords = ""
    properties.subject = ""

def content_signature(doc: Any) -> tuple[Any, ...]:
    from lxml import etree
    texts = tuple(re.sub(r'\s+', '', ''.join(e.itertext())) for e in doc._element.xpath('.//w:t'))
    # Compare text as a stream: harmless run splits and attachment tabs may change.
    objects = tuple(etree.tostring(e, method='c14n') for e in doc._element.xpath('.//w:drawing | .//w:pict | .//w:hyperlink | .//w:fldSimple | .//w:bookmarkStart | .//w:bookmarkEnd'))
    rels = tuple(sorted((r.rId, r.reltype, r.target_ref) for r in doc.part.rels.values() if not r.reltype.endswith('/footer')))
    return ''.join(texts), objects, rels, len(doc.tables)
