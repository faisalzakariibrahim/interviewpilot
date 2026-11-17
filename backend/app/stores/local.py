"""Local storage: everything in backend/data/ on this machine."""

import json
import os
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..resume_store import ResumeSession, ResumeStore
from .base import MAX_INTERVIEWS, MAX_NOTES, SessionMeta, Store, User, validate_interview


def _meta(session: ResumeSession) -> SessionMeta:
    return SessionMeta(
        id=session.id,
        role=session.role,
        filename=session.filename,
        created_at=session.created_at,
        passage_count=len(session.chunks),
        has_job_description=bool(session.job_description.strip()),
    )


def _write_json(path: Path, data: Any) -> None:
    """Writes atomically, readable by this user only."""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as out:
            json.dump(data, out, indent=2)
        os.chmod(temp, 0o600)
        os.replace(temp, path)
    except BaseException:
        if os.path.exists(temp):
            os.unlink(temp)
        raise


def _read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


class LocalStore(Store):
    """`data_dir` holds sessions/, profile.json and interviews.json. None keeps all in memory."""

    def __init__(self, data_dir: Optional[Path]) -> None:
        self.data_dir = Path(data_dir) if data_dir else None
        self.resumes = ResumeStore(self.data_dir / "sessions" if self.data_dir else None)
        self.resumes.load_all()
        self._notes = ""
        self._interviews: List[Dict[str, Any]] = []
        if self.data_dir:
            self._notes = str(_read_json(self.data_dir / "profile.json", {}).get("notes", ""))
            loaded = _read_json(self.data_dir / "interviews.json", [])
            self._interviews = [item for item in loaded if isinstance(item, dict)] if isinstance(loaded, list) else []

    @property
    def engine(self) -> str:  # type: ignore[override]
        return self.resumes.engine

    def _save_interviews(self) -> None:
        if self.data_dir:
            _write_json(self.data_dir / "interviews.json", self._interviews)

    # sessions -------------------------------------------------------------
    async def create_session(self, user: User, role: str, job_description: str, filename: str, text: str) -> SessionMeta:
        return _meta(self.resumes.create(role=role, job_description=job_description, filename=filename, text=text))

    async def get_session(self, user: User, session_id: str) -> Optional[SessionMeta]:
        session = self.resumes.get(session_id)
        return _meta(session) if session else None

    async def list_sessions(self, user: User) -> List[SessionMeta]:
        return [_meta(session) for session in self.resumes.list()]

    async def delete_session(self, user: User, session_id: str) -> bool:
        return self.resumes.delete(session_id)

    async def search(self, user: User, session_id: str, query: str, k: int) -> List[str]:
        return self.resumes.search(session_id, query, k)

    async def job_description(self, user: User, session_id: str) -> str:
        session = self.resumes.get(session_id)
        return session.job_description if session else ""

    # notes ------------------------------------------------------------------
    async def get_notes(self, user: User) -> str:
        return self._notes

    async def set_notes(self, user: User, notes: str) -> None:
        self._notes = notes[:MAX_NOTES]
        if self.data_dir:
            _write_json(self.data_dir / "profile.json", {"notes": self._notes})

    # interviews -------------------------------------------------------------
    async def list_interviews(self, user: User) -> List[Dict[str, Any]]:
        return sorted(self._interviews, key=lambda item: str(item.get("startedAt", "")), reverse=True)

    async def get_interview(self, user: User, interview_id: str) -> Optional[Dict[str, Any]]:
        return next((item for item in self._interviews if item.get("id") == interview_id), None)

    async def save_interview(self, user: User, payload: Dict[str, Any]) -> None:
        payload = validate_interview(payload)
        self._interviews = [item for item in self._interviews if item.get("id") != payload["id"]]
        self._interviews.append(payload)
        self._interviews = sorted(self._interviews, key=lambda item: str(item.get("startedAt", "")))[-MAX_INTERVIEWS:]
        self._save_interviews()

    async def clear_interviews(self, user: User) -> None:
        self._interviews = []
        self._save_interviews()

    async def delete_everything(self, user: User) -> None:
        for session in list(self.resumes.list()):
            self.resumes.delete(session.id)
        await self.clear_interviews(user)
        await self.set_notes(user, "")
