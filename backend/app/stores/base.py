"""What every storage backend provides.

Two implementations:
- LocalStore: files under backend/data/ on this machine (the default).
- SupabaseStore: Postgres in your own Supabase project, cloud mode only.
  Every row is tied to the signed-in user by row-level security, and every
  piece of content is encrypted before it leaves this process.

Written for Python 3.9+.
"""

import json
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

MAX_NOTES = 2000
MAX_INTERVIEW_BYTES = 200_000
MAX_INTERVIEWS = 200
INTERVIEW_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")


class StoreError(Exception):
    """A storage failure. `status` is the HTTP status to answer with."""

    def __init__(self, message: str, status: int = 500) -> None:
        super().__init__(message)
        self.status = status


@dataclass
class User:
    """Who is asking. `id` is "local" in local mode."""

    id: str
    email: Optional[str] = None
    access_token: Optional[str] = None
    first_name: str = ""


@dataclass
class SessionMeta:
    id: str
    role: str
    filename: str
    created_at: str
    passage_count: int
    has_job_description: bool


def validate_interview(payload: Any) -> Dict[str, Any]:
    """Checks the shape and size of an interview result before it is stored."""
    if not isinstance(payload, dict):
        raise StoreError("An interview must be a JSON object.", 422)
    interview_id = payload.get("id")
    if not isinstance(interview_id, str) or not INTERVIEW_ID.match(interview_id):
        raise StoreError("The interview id is missing or malformed.", 422)
    if not isinstance(payload.get("startedAt"), str) or not isinstance(payload.get("turns"), list):
        raise StoreError("The interview is missing startedAt or turns.", 422)
    if len(json.dumps(payload)) > MAX_INTERVIEW_BYTES:
        raise StoreError("That interview is too large to store.", 413)
    return payload


class Store:
    """The interface. Every method takes the asking user first."""

    engine = "unknown"

    # sessions -------------------------------------------------------------
    async def create_session(
        self, user: User, role: str, job_description: str, filename: str, text: str
    ) -> SessionMeta:
        raise NotImplementedError

    async def get_session(self, user: User, session_id: str) -> Optional[SessionMeta]:
        raise NotImplementedError

    async def list_sessions(self, user: User) -> List[SessionMeta]:
        raise NotImplementedError

    async def delete_session(self, user: User, session_id: str) -> bool:
        raise NotImplementedError

    async def search(self, user: User, session_id: str, query: str, k: int) -> List[str]:
        raise NotImplementedError

    async def job_description(self, user: User, session_id: str) -> str:
        raise NotImplementedError

    # notes ------------------------------------------------------------------
    async def get_notes(self, user: User) -> str:
        raise NotImplementedError

    async def set_notes(self, user: User, notes: str) -> None:
        raise NotImplementedError

    # interviews -------------------------------------------------------------
    async def list_interviews(self, user: User) -> List[Dict[str, Any]]:
        raise NotImplementedError

    async def get_interview(self, user: User, interview_id: str) -> Optional[Dict[str, Any]]:
        raise NotImplementedError

    async def save_interview(self, user: User, payload: Dict[str, Any]) -> None:
        """Inserts, or replaces the one with the same id."""
        raise NotImplementedError

    async def clear_interviews(self, user: User) -> None:
        raise NotImplementedError

    # everything ---------------------------------------------------------------
    async def delete_everything(self, user: User) -> None:
        raise NotImplementedError
