"""The local resume index.

Everything here stays on this machine:
- resume passages are saved under backend/data/sessions/<id>/ so a restart
  doesn't lose them, and are deleted when the session is removed;
- search runs in FAISS when it is installed, and in NumPy otherwise.

Vectors are hashed keyword features (words and word pairs), so there is no
embedding model to download and nothing is sent anywhere to build the index.
For a one-to-three page resume that is plenty. To use a real embedding model,
replace `embed()`: nothing else depends on how the vectors are made.

Written for Python 3.9+.
"""

import json
import math
import re
import shutil
import uuid
import zlib
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np

try:  # FAISS is optional: the launcher installs it when a wheel exists.
    import faiss  # type: ignore
except Exception:  # pragma: no cover - depends on the machine
    faiss = None

DIMENSIONS = 1024
SESSION_ID = re.compile(r"^[a-f0-9]{32}$")
_TOKEN = re.compile(r"[a-z0-9]+[+#]*")
_STOPWORDS = frozenset(
    "a an and are as at be by for from has have i in is it its my of on or that the this to was were "
    "with will your you we our their they them about into over under than then".split()
)


def _features(text: str) -> List[str]:
    words = [w for w in _TOKEN.findall(text.lower()) if w not in _STOPWORDS and len(w) > 1]
    return words + ["{} {}".format(a, b) for a, b in zip(words, words[1:])]


def embed(texts: List[str]) -> np.ndarray:
    """Texts -> unit-length float32 vectors, one row each."""
    matrix = np.zeros((len(texts), DIMENSIONS), dtype=np.float32)
    for row, text in enumerate(texts):
        counts: Dict[int, int] = {}
        for feature in _features(text):
            slot = zlib.crc32(feature.encode("utf-8")) % DIMENSIONS
            counts[slot] = counts.get(slot, 0) + 1
        for slot, count in counts.items():
            matrix[row, slot] = 1.0 + math.log(count)
        norm = float(np.linalg.norm(matrix[row]))
        if norm > 0:
            matrix[row] /= norm
    return matrix


def chunk_text(text: str, size: int = 700, overlap: int = 120) -> List[str]:
    """Splits a resume into overlapping passages, breaking at line boundaries."""
    lines = [line.strip() for line in text.splitlines()]
    chunks: List[str] = []
    current = ""
    for line in lines:
        if not line:
            continue
        # A single very long line (a PDF paragraph) is cut into windows.
        while len(line) > size:
            head, line = line[:size], line[size - overlap :]
            if current:
                chunks.append(current)
                current = ""
            chunks.append(head)
        if current and len(current) + 1 + len(line) > size:
            chunks.append(current)
            tail = current[-overlap:]
            # Start the overlap at a word boundary.
            current = tail[tail.find(" ") + 1 :] if " " in tail else ""
        current = "{}\n{}".format(current, line) if current else line
    if current:
        chunks.append(current)
    return chunks


@dataclass
class ResumeSession:
    id: str
    role: str
    job_description: str
    filename: str
    created_at: str
    chunks: List[str]
    vectors: np.ndarray
    index: Any = None  # a faiss index when FAISS is installed


class ResumeStore:
    def __init__(self, data_dir: Optional[Path] = None) -> None:
        """`data_dir` None keeps sessions in memory only."""
        self.data_dir = Path(data_dir) if data_dir else None
        self._sessions: Dict[str, ResumeSession] = {}

    @property
    def engine(self) -> str:
        return "faiss" if faiss is not None else "numpy"

    # --- lifecycle -----------------------------------------------------------

    def _build(self, meta: Dict[str, str], chunks: List[str]) -> ResumeSession:
        vectors = embed(chunks)
        index = None
        if faiss is not None:
            index = faiss.IndexFlatIP(DIMENSIONS)
            index.add(vectors)
        return ResumeSession(
            id=meta["id"],
            role=meta["role"],
            job_description=meta.get("job_description", ""),
            filename=meta.get("filename", "resume"),
            created_at=meta["created_at"],
            chunks=chunks,
            vectors=vectors,
            index=index,
        )

    def create(self, role: str, job_description: str, filename: str, text: str) -> ResumeSession:
        chunks = chunk_text(text)
        if not chunks:
            raise ValueError("The resume has no text to index.")
        meta = {
            "id": uuid.uuid4().hex,
            "role": role,
            "job_description": job_description,
            "filename": filename,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        session = self._build(meta, chunks)
        self._sessions[session.id] = session
        if self.data_dir:
            folder = self.data_dir / session.id
            folder.mkdir(parents=True, exist_ok=True)
            (folder / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
            (folder / "chunks.json").write_text(json.dumps(chunks, indent=2), encoding="utf-8")
        return session

    def load_all(self) -> int:
        """Rebuilds the index of every saved session. Returns how many loaded."""
        if not self.data_dir or not self.data_dir.is_dir():
            return 0
        loaded = 0
        for folder in self.data_dir.iterdir():
            if not folder.is_dir() or not SESSION_ID.match(folder.name):
                continue
            try:
                meta = json.loads((folder / "meta.json").read_text(encoding="utf-8"))
                chunks = json.loads((folder / "chunks.json").read_text(encoding="utf-8"))
                if meta.get("id") != folder.name or not isinstance(chunks, list) or not chunks:
                    continue
                self._sessions[folder.name] = self._build(meta, [str(chunk) for chunk in chunks])
                loaded += 1
            except (OSError, ValueError, KeyError):
                continue  # a damaged folder is skipped, not fatal
        return loaded

    def get(self, session_id: str) -> Optional[ResumeSession]:
        return self._sessions.get(session_id)

    def list(self) -> List[ResumeSession]:
        return sorted(self._sessions.values(), key=lambda s: s.created_at, reverse=True)

    def delete(self, session_id: str) -> bool:
        """Forgets the session and deletes its files."""
        if not SESSION_ID.match(session_id):
            return False
        existed = self._sessions.pop(session_id, None) is not None
        if self.data_dir:
            folder = self.data_dir / session_id
            if folder.is_dir():
                shutil.rmtree(folder, ignore_errors=True)
                existed = True
        return existed

    # --- search --------------------------------------------------------------

    def search(self, session_id: str, query: str, k: int) -> List[str]:
        """The k passages closest to the query, best first. Empty for an unknown session."""
        session = self._sessions.get(session_id)
        if session is None or not session.chunks:
            return []
        k = max(1, min(k, len(session.chunks)))
        query_vector = embed([query])
        if session.index is not None:
            _, positions = session.index.search(query_vector, k)
            order = [int(p) for p in positions[0] if p >= 0]
        else:
            scores = session.vectors @ query_vector[0]
            order = [int(p) for p in np.argsort(-scores, kind="stable")[:k]]
        return [session.chunks[p] for p in order]
