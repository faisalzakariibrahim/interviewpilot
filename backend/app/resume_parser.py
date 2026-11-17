"""Reads the text out of an uploaded resume: PDF, DOCX, TXT or Markdown.

Parsing happens in memory on this machine. The file itself is never saved.
"""

import io
import re
from pathlib import PurePath

SUPPORTED = (".pdf", ".docx", ".txt", ".md")
MAX_BYTES = 4 * 1024 * 1024  # under the 4.5 MB request limit of serverless hosts
MAX_CHARACTERS = 60_000


class ResumeError(ValueError):
    """A problem with the upload, worded for the person."""


def _pdf(data: bytes) -> str:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    if reader.is_encrypted:
        raise ResumeError("That PDF is password-protected. Export an unlocked copy and try again.")
    return "\n\n".join((page.extract_text() or "") for page in reader.pages)


def _docx(data: bytes) -> str:
    from docx import Document

    document = Document(io.BytesIO(data))
    parts = [paragraph.text for paragraph in document.paragraphs]
    for table in document.tables:  # many resume templates are built from tables
        for row in table.rows:
            cells = []
            for cell in row.cells:
                text = cell.text.strip()
                if text and text not in cells:  # merged cells repeat their text
                    cells.append(text)
            if cells:
                parts.append(" | ".join(cells))
    return "\n".join(parts)


def extract_text(filename: str, data: bytes) -> str:
    """Returns the resume's text, tidied. Raises ResumeError with what went wrong."""
    suffix = PurePath(filename or "").suffix.lower()
    if suffix not in SUPPORTED:
        raise ResumeError("Upload a PDF, DOCX, TXT or MD file.")
    if not data:
        raise ResumeError("That file is empty.")
    if len(data) > MAX_BYTES:
        raise ResumeError("That file is over 4 MB. Upload a smaller copy.")

    try:
        if suffix == ".pdf":
            text = _pdf(data)
        elif suffix == ".docx":
            text = _docx(data)
        else:
            text = data.decode("utf-8", errors="replace")
    except ResumeError:
        raise
    except Exception as error:
        raise ResumeError("Couldn't read that file. Is it a valid {} file?".format(suffix[1:].upper())) from error

    text = text.replace("\x00", "").replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text[:MAX_CHARACTERS]
