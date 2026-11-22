"""Offline Office operations that read entire documents or return several artifacts."""
from __future__ import annotations

import csv
import hashlib
import io
import re
from pathlib import Path
from zipfile import ZipFile

from docx import Document
from docx.oxml.ns import qn
from docx.text.paragraph import Paragraph
from docxcompose.composer import Composer
from openpyxl import load_workbook
from openpyxl.formula.tokenizer import Tokenizer
from openpyxl.utils import get_column_letter
from openpyxl.worksheet._reader import WorkSheetParser


def file_label(value: str) -> str:
    label = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", value).strip(" .")[:65].rstrip(" .") or "未命名"
    if re.match(r"^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)", label, re.IGNORECASE):
        return "_" + label
    return label


def body_text(element) -> list[str]:
    """Tab-separated table cells in source order, including nested tables."""
    if element.tag == qn("w:p"):
        separators = {qn("w:tab"): "\t", qn("w:br"): "\n", qn("w:cr"): "\n",
                      qn("w:noBreakHyphen"): "\u2011", qn("w:softHyphen"): "\u00ad"}
        return ["".join((node.text or "") if node.tag == qn("w:t") else separators.get(node.tag, "")
                        for node in element.iter())]
    if element.tag == qn("w:tbl"):
        return ["\t".join("\n".join(body_text(cell)) for cell in row.findall(qn("w:tc")))
                for row in element.findall(qn("w:tr"))]
    return [line for node in element if node.tag in {qn("w:p"), qn("w:tbl")}
            for line in body_text(node)]


def export_text(source: Path, target: Path) -> list[str]:
    body = Document(source).element.body
    if body.xpath(".//w:sdt | .//w:altChunk | .//w:txbxContent | .//w:ins | .//w:del | .//w:customXml | .//w:smartTag | .//w:moveTo | .//w:moveFrom"):
        raise ValueError("正文含控件、文本框、嵌入文档或修订，无法确认完整文字；请先保存普通正文副本。")
    text = "\n".join(body_text(body))
    if not text.strip():
        raise ValueError("正文和表格中没有可提取的文字；纯图片 Word 需要 OCR。")
    target.write_text(text + "\n", encoding="utf-8-sig")
    if target.read_text(encoding="utf-8-sig") != text + "\n":
        raise ValueError("文本回读校验失败")
    return ["已按正文顺序导出段落和表格；表格以制表符分列。页眉、页脚、脚注及图片不在正文导出范围内。"]


def export_workbook_text(source: Path, target: Path) -> list[str]:
    workbook = load_workbook(source, read_only=True, data_only=False)
    digest = hashlib.sha256()
    row_count = 0
    try:
        visible = [sheet for sheet in workbook.worksheets if sheet.sheet_state == "visible"]
        if not visible:
            raise ValueError("工作簿没有可读取的可见工作表。")
        with target.open("wb") as stream:
            def write(value: str) -> None:
                encoded = value.encode("utf-8")
                stream.write(encoded)
                digest.update(encoded)

            write("\ufeff")
            for sheet_index, sheet in enumerate(visible):
                write(("\n" if sheet_index else "") + f"[{sheet.title}]\n")
                sheet_rows = 0
                # read_only Worksheet.iter_rows expands empty row gaps and pads to
                # the maximum column. Use the same parser on actual XML rows only.
                with sheet._get_source() as xml:
                    parser = WorkSheetParser(xml, sheet._shared_strings, epoch=workbook.epoch,
                                             date_formats=workbook._date_formats,
                                             timedelta_formats=workbook._timedelta_formats)
                    for row_number, row in parser.parse():
                        cells = sorted((c for c in row if c["value"] is not None), key=lambda c: c["column"])
                        if not cells:
                            continue
                        # Address an unusually sparse row explicitly, rather than
                        # generating thousands of tabs for a single distant cell.
                        sparse = cells[-1]["column"] > len(cells) + 256
                        fields = []
                        for cell in cells:
                            column, value = cell["column"], cell["value"]
                            if not 1 <= column <= 16384:
                                raise ValueError(f"工作表「{sheet.title}」存在无效列号。")
                            if cell["data_type"] == "f" and not isinstance(value, str):
                                value = getattr(value, "text", None)
                                if not value:
                                    raise ValueError(f"工作表「{sheet.title}」含无法导出公式原文的特殊数据表。")
                            if sparse:
                                fields.extend([f"{get_column_letter(column)}{row_number}", str(value)])
                            else:
                                fields.extend([""] * (column - 1 - len(fields)))
                                fields.append(str(value))
                        line = io.StringIO(newline="")
                        csv.writer(line, delimiter="\t", lineterminator="\r\n").writerow(fields)
                        write(line.getvalue()[:-2] + "\n")
                        sheet_rows += 1
                if not sheet_rows:
                    write("（空工作表）\n")
                row_count += sheet_rows
    finally:
        workbook.close()
    reopened = hashlib.sha256()
    with target.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            reopened.update(block)
    if reopened.digest() != digest.digest():
        raise ValueError("工作表导出文本回读校验失败。")
    return [f"已按原序导出 {len(visible)} 张可见工作表、{row_count} 行非空数据；保留公式原文，跳过隐藏表和纯空行。极稀疏行以单元格地址标识。"]


def supported_body(document):
    body = document.element.body
    if len(document.sections) != 1 or body.sectPr is None or body[-1] is not body.sectPr:
        raise ValueError("文档包含多个节或缺少节设置，请按节单独整理后处理。")
    if any(node.tag not in {qn("w:p"), qn("w:tbl"), qn("w:sectPr")} for node in body):
        raise ValueError("正文含嵌入文档或块级控件，无法安全合并或拆分。")
    if body.xpath(".//w:sdt | .//w:ins | .//w:del | .//w:moveFrom | .//w:moveTo | .//w:footnoteReference | .//w:endnoteReference | .//w:commentReference | .//w:object | .//w:pict | .//w:altChunk"):
        raise ValueError("请先处理修订、批注、脚注或旧式嵌入对象，再合并或拆分。")
    return body


def body_signature(nodes) -> tuple:
    """Preserve paragraph order, table structure and inline image counts on readback."""
    return tuple((node.tag, tuple(body_text(node)), len(node.xpath(".//w:drawing")))
                 for node in nodes if node.tag in {qn("w:p"), qn("w:tbl")})


def merge_documents(sources: list[Path], target: Path) -> list[str]:
    if len(sources) < 2:
        raise ValueError("合并 Word 至少需要两份 DOCX。")
    base = Document(sources[0])
    body = supported_body(base)
    expected = list(body_signature(body))
    composer = Composer(base)
    for source in sources[1:]:
        document = Document(source)
        body = supported_body(document)
        if body.sectPr.xpath("./w:headerReference | ./w:footerReference"):
            raise ValueError("后续文档含独立页眉或页脚；当前合并仅继承首份文档的页眉和页脚。")
        divider = base.add_page_break()
        expected.extend(body_signature([divider._p]))
        expected.extend(body_signature(body))
        composer.append(document)
    composer.save(target)
    if body_signature(Document(target).element.body) != tuple(expected):
        raise ValueError("合并文档重新打开后正文、表格或图片数未通过校验。")
    return ["各份材料另起一页，沿用首份材料的页面设置和同名样式。已核对正文、表格及图片数量。"]


def is_heading_one(node, document) -> bool:
    if node.tag != qn("w:p"):
        return False
    paragraph = Paragraph(node, document)
    level = node.xpath("./w:pPr/w:outlineLvl/@w:val")
    if level:
        return level[0] == "0"
    style = paragraph.style
    seen = set()
    while style is not None and style.style_id not in seen:
        seen.add(style.style_id)
        level = style.element.xpath("./w:pPr/w:outlineLvl/@w:val")
        if level:
            return level[0] == "0"
        if style.style_id == "Heading1" or style.name in ("Heading 1", "标题 1", "标题1"):
            return True
        style = style.base_style
    return False


def only_page_break(paragraph) -> bool:
    # A paragraph with properties, bookmarks, extra runs or attached objects
    # may carry meaningful layout or content. Only discard a bare page break.
    if paragraph.tag != qn("w:p") or len(paragraph) != 1:
        return False
    run = paragraph[0]
    return (run.tag == qn("w:r") and len(run) == 1 and run[0].tag == qn("w:br")
            and dict(run[0].attrib) == {qn("w:type"): "page"})


def split_document(source: Path, stem: str, directory: Path) -> list[Path]:
    document = Document(source)
    body = supported_body(document)
    # Fields and navigation can refer to text that would move to a different file.
    if body.xpath(".//w:fldSimple | .//w:fldChar | .//w:hyperlink[@w:anchor]"):
        raise ValueError("正文含目录、域或文档内跳转，拆分可能断开引用，请先转换为普通正文。")
    nodes = list(body)[:-1]
    boundaries = [(i, Paragraph(node, document).text.strip() or "无标题")
                  for i, node in enumerate(nodes) if is_heading_one(node, document)]
    if not boundaries:
        raise ValueError("未找到一级标题。请将各章标题设为“标题 1”样式或一级大纲。")
    if boundaries[0][0]:
        boundaries.insert(0, (0, "前言"))
    chapters = []
    for index, (start, title) in enumerate(boundaries):
        end = boundaries[index + 1][0] if index + 1 < len(boundaries) else len(nodes)
        if end < len(nodes) and end > start and only_page_break(nodes[end - 1]):
            end -= 1
        if start < end:
            chapters.append((start, end, title))
    if len(chapters) < 2:
        raise ValueError("仅找到一个章节，没有可拆分的独立部分。")
    outputs = []
    for index, (start, end, title) in enumerate(chapters):
        part = Document(source)
        part_body = part.element.body
        for position, node in enumerate(list(part_body)[:-1]):
            if not start <= position < end:
                part_body.remove(node)
        # Prune relationships owned only by other chapters (notably images).
        active = {value for node in part.element.iter() for key, value in node.attrib.items()
                  if key.startswith("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}")}
        for rid, rel in list(part.part.rels.items()):
            if rel.reltype.rsplit("/", 1)[-1] in {"image", "hyperlink", "chart", "oleObject", "package", "diagramData", "diagramLayout", "diagramQuickStyle", "diagramColors"} and rid not in active:
                del part.part.rels[rid]
        target = directory / f"{stem}-{index + 1:02d}-{file_label(title)}.docx"
        part.save(target)
        if body_signature(Document(target).element.body) != body_signature(nodes[start:end]):
            raise ValueError("拆分文档重新打开后校验失败。")
        outputs.append(target)
    return outputs


def check_formula(formula, title: str) -> None:
    if not isinstance(formula, str):
        raise ValueError(f"工作表「{title}」使用特殊数组或数据表公式，无法独立拆分。")
    for token in Tokenizer(formula).items:
        if token.type == "FUNC" and token.value.upper().removeprefix("_XLFN.") in ("INDIRECT(", "SHEET(", "SHEETS("):
            raise ValueError(f"工作表「{title}」含动态工作表引用，拆分可能改变计算结果。")
        if token.subtype != "RANGE":
            continue
        ref = token.value
        if "!" in ref:
            sheet, ref = ref.rsplit("!", 1)
            if sheet.startswith("'") and sheet.endswith("'"):
                sheet = sheet[1:-1].replace("''", "'")
            if sheet.casefold() != title.casefold():
                raise ValueError(f"工作表「{title}」有跨表或外部公式引用，请先保留数值副本。")
        address = r"\$?[A-Za-z]{1,3}\$?[1-9]\d*"
        full_range = rf"(?:{address}(?::{address})?|\$?[A-Za-z]{{1,3}}:\$?[A-Za-z]{{1,3}}|\$?[1-9]\d*:\$?[1-9]\d*)"
        if not re.fullmatch(full_range, ref):
            raise ValueError(f"工作表「{title}」含名称或结构化公式引用，无法确认拆分后的计算结果。")


def split_workbook(source: Path, stem: str, directory: Path) -> list[Path]:
    # openpyxl cannot round-trip every OOXML extension (e.g. SmartArt, slicers).
    with ZipFile(source) as archive:
        advanced = ("xl/drawings/", "xl/charts/", "xl/pivot", "xl/slicer", "xl/activeX/",
                    "xl/externalLinks/", "xl/embeddings/", "xl/connections", "xl/queryTables/",
                    "xl/threadedComments/", "xl/richData/", "xl/ctrlProps/", "xl/chartsheets/")
        if any(name.startswith(advanced) for name in archive.namelist()):
            raise ValueError("工作簿含绘图、图表、透视表或外部数据等对象；请先另存普通表格副本。")
    workbook = load_workbook(source, rich_text=True)
    try:
        sheets = list(workbook.worksheets)
        if len(sheets) < 2:
            raise ValueError("工作簿只有一个工作表，无需拆分。")
        if workbook.defined_names:
            raise ValueError("工作簿含全局定义名称，拆分可能影响引用，请先整理名称。")
        for sheet in sheets:
            if sheet.sheet_state != "visible":
                raise ValueError("工作簿含隐藏工作表；请先确认并处理隐藏表，再拆分。")
            if sheet.defined_names or sheet.conditional_formatting or sheet.data_validations.count:
                raise ValueError(f"工作表「{sheet.title}」含定义名称、条件格式或数据验证，请先确认其跨表引用。")
            for cell in sheet._cells.values():
                if cell.data_type == "f":
                    check_formula(cell.value, sheet.title)
                if cell.hyperlink and cell.hyperlink.location:
                    raise ValueError(f"工作表「{sheet.title}」含工作簿内部链接，拆分可能断开引用。")
        outputs = []
        for index, sheet in enumerate(sheets, start=1):
            # Reuse the style/format tables and the loaded cells without copying
            # or rereading the full workbook once for each worksheet.
            workbook._sheets = [sheet]
            workbook.active = 0
            for view in workbook.views:
                view.firstSheet = 0
            sheet.sheet_view.tabSelected = True
            target = directory / f"{stem}-{index:02d}-{file_label(sheet.title)}.xlsx"
            workbook.save(target)
            check = load_workbook(target, read_only=True)
            try:
                if check.sheetnames != [sheet.title] or check.active.max_row != sheet.max_row or check.active.max_column != sheet.max_column:
                    raise ValueError("拆分工作表重新打开后名称或范围不一致。")
            finally:
                check.close()
            outputs.append(target)
        return outputs
    finally:
        workbook.close()
