"""Browser adapter for the desktop DOCX layout rules."""

from io import BytesIO
from pathlib import PurePosixPath
from xml.etree import ElementTree
from zipfile import BadZipFile, ZIP_DEFLATED, ZIP_STORED, ZipFile

from docx import Document
from docx.opc.exceptions import PackageNotFoundError
from lxml.etree import XMLSyntaxError

from gongwen_layout import effective_bold, layout_guard
from zhai_layout_helpers import (
    clear_docx_metadata,
    content_signature,
    format_existing_docx_as_gongwen,
)


MIB = 1024 * 1024
MAX_FILE_SIZE = 10 * MIB
MAX_EXPANDED_SIZE = 64 * MIB
MAX_XML_SIZE = 8 * MIB
MAX_ARCHIVE_MEMBERS = 1200
DOCX_CONTENT_TYPE = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
)
ARCHIVE_ERROR = "无法读取这个 DOCX。请在 Word 或 WPS 中打开，再另存为 DOCX 后重试。"


class DocumentError(Exception):
    pass


def check_package(raw):
    if not 0 < len(raw) <= MAX_FILE_SIZE:
        raise DocumentError("请选择小于或等于 10 MB 的 DOCX 文件。")
    with ZipFile(BytesIO(raw)) as archive:
        entries = archive.infolist()
        names = set()
        if len(entries) > MAX_ARCHIVE_MEMBERS or sum(e.file_size for e in entries) > MAX_EXPANDED_SIZE:
            raise DocumentError("文档解压后的内容过大，请缩小文件后再试。")
        for entry in entries:
            name = entry.filename
            path = PurePosixPath(name)
            if (path.is_absolute() or ".." in path.parts or "\\" in name or name in names
                    or entry.flag_bits & 1 or entry.compress_type not in (ZIP_STORED, ZIP_DEFLATED)):
                raise DocumentError(ARCHIVE_ERROR)
            names.add(name)
            if name.lower().endswith((".xml", ".rels")):
                if entry.file_size > MAX_XML_SIZE:
                    raise DocumentError("文档中的单个 XML 部分过大，请缩小文件后再试。")
                markup = archive.read(entry).replace(b"\0", b"").upper()
                if b"<!DOCTYPE" in markup or b"<!ENTITY" in markup:
                    raise DocumentError("文档包含不支持的 XML 声明，请另存为 DOCX 后重试。")
        if not {"[Content_Types].xml", "_rels/.rels", "word/document.xml"}.issubset(names):
            raise DocumentError(ARCHIVE_ERROR)
        content_types = ElementTree.fromstring(archive.read("[Content_Types].xml"))
        if not any(part.get("PartName") == "/word/document.xml"
                   and part.get("ContentType") == DOCX_CONTENT_TYPE for part in content_types):
            raise DocumentError("请选择普通 DOCX 文档。带宏或加密文档请先另存为 DOCX。")


def bold_signature(document):
    signature = bytearray()
    for paragraph in document.paragraphs:
        for run in paragraph.runs:
            state = bytes((effective_bold(paragraph, run) is True,))
            signature.extend(state * sum(not char.isspace() for char in run.text))
    return signature


def process_docx(raw):
    """Return an independently reopened copy, or a user-facing error."""
    try:
        check_package(raw)
        document = Document(BytesIO(raw))
        guard = layout_guard(document)
        if guard:
            raise DocumentError(guard)
        original = content_signature(document)
        bold = bold_signature(document)
        changes, notes = format_existing_docx_as_gongwen(document)
        clear_docx_metadata(document)
        result = BytesIO()
        document.save(result)
        reopened = Document(BytesIO(result.getvalue()))
        if content_signature(reopened) != original or bold_signature(reopened) != bold:
            raise DocumentError("新文件未通过内容与加粗复核，未生成下载成果。")
        return {"data": result.getvalue(), "notes": notes, "changes": changes}
    except DocumentError as exc:
        return {"error": str(exc)}
    except (BadZipFile, ElementTree.ParseError, PackageNotFoundError, XMLSyntaxError, KeyError):
        return {"error": ARCHIVE_ERROR}
