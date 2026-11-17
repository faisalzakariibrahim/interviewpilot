"""Cloud storage in your own Supabase project.

Three layers keep one person's data from reaching anyone else:
1. Every request carries the signed-in user's own token and the public anon
   key, never a service-role key. Postgres row-level security therefore
   decides what each request may touch: only rows whose user_id is that
   user's, and only for emails on the allowlist (supabase/schema.sql).
2. Content columns are sealed with AES-256-GCM (app/crypto.py) bound to
   table + user + row, using a key Supabase never sees.
3. The raw resume file is never stored, and contact details are stripped
   before anything is sealed.
"""

import json
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import httpx
import numpy as np

from ..crypto import CryptoError, Sealer
from ..resume_store import chunk_text, embed
from .base import (
    MAX_INTERVIEWS,
    MAX_NOTES,
    SessionMeta,
    Store,
    StoreError,
    User,
    validate_interview,
)

SESSION_COLUMNS = "id,role_enc,filename_enc,passage_count,has_job_description,created_at"


class SupabaseStore(Store):
    engine = "supabase"

    def __init__(
        self,
        url: str,
        anon_key: str,
        sealer: Sealer,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ) -> None:
        self.rest = url.rstrip("/") + "/rest/v1"
        self.anon_key = anon_key
        self.sealer = sealer
        self.transport = transport

    # --- plumbing --------------------------------------------------------------

    async def _call(
        self,
        user: User,
        method: str,
        table: str,
        params: Optional[Dict[str, str]] = None,
        body: Any = None,
        prefer: Optional[str] = None,
    ) -> Any:
        if not user.access_token:
            raise StoreError("Not signed in.", 401)
        headers = {
            "apikey": self.anon_key,
            "Authorization": "Bearer " + user.access_token,
            "Content-Type": "application/json",
        }
        if prefer:
            headers["Prefer"] = prefer
        try:
            async with httpx.AsyncClient(timeout=15, transport=self.transport) as client:
                response = await client.request(
                    method, "{}/{}".format(self.rest, table), params=params, json=body, headers=headers
                )
        except httpx.HTTPError as error:
            raise StoreError("The database isn't reachable right now.", 503) from error
        if response.status_code in (401, 403):
            raise StoreError("Your session expired. Sign in again.", 401)
        if response.status_code >= 400:
            # Postgres error text can echo values: keep it out of responses and logs.
            raise StoreError("The database refused the request ({}).".format(response.status_code), 502)
        if response.status_code == 204 or not response.content:
            return None
        return response.json()

    def _seal(self, value: str, table: str, user: User, row: str) -> str:
        return self.sealer.seal(value, "{}:{}:{}".format(table, user.id, row))

    def _open(self, value: str, table: str, user: User, row: str) -> str:
        try:
            return self.sealer.open(value, "{}:{}:{}".format(table, user.id, row))
        except CryptoError as error:
            raise StoreError("A stored record couldn't be decrypted. Was DATA_ENCRYPTION_KEY changed?", 500) from error

    def _session_meta(self, user: User, row: Dict[str, Any]) -> SessionMeta:
        return SessionMeta(
            id=row["id"],
            role=self._open(row["role_enc"], "ip_sessions.role", user, row["id"]),
            filename=self._open(row["filename_enc"], "ip_sessions.filename", user, row["id"]),
            created_at=str(row["created_at"]),
            passage_count=int(row["passage_count"]),
            has_job_description=bool(row["has_job_description"]),
        )

    async def _session_row(self, user: User, session_id: str, columns: str) -> Optional[Dict[str, Any]]:
        try:
            uuid.UUID(session_id)
        except ValueError:
            return None
        rows = await self._call(user, "GET", "ip_sessions", params={"id": "eq." + session_id, "select": columns})
        return rows[0] if rows else None

    # --- sessions --------------------------------------------------------------

    async def create_session(self, user: User, role: str, job_description: str, filename: str, text: str) -> SessionMeta:
        chunks = chunk_text(text)
        if not chunks:
            raise ValueError("The resume has no text to index.")
        session_id = str(uuid.uuid4())
        row = {
            "id": session_id,
            "user_id": user.id,
            "role_enc": self._seal(role, "ip_sessions.role", user, session_id),
            "filename_enc": self._seal(filename, "ip_sessions.filename", user, session_id),
            "job_description_enc": self._seal(job_description, "ip_sessions.job_description", user, session_id),
            "chunks_enc": self._seal(json.dumps(chunks), "ip_sessions.chunks", user, session_id),
            "passage_count": len(chunks),
            "has_job_description": bool(job_description.strip()),
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        await self._call(user, "POST", "ip_sessions", body=row, prefer="return=minimal")
        return self._session_meta(user, row)

    async def get_session(self, user: User, session_id: str) -> Optional[SessionMeta]:
        row = await self._session_row(user, session_id, SESSION_COLUMNS)
        return self._session_meta(user, row) if row else None

    async def list_sessions(self, user: User) -> List[SessionMeta]:
        rows = await self._call(
            user, "GET", "ip_sessions", params={"select": SESSION_COLUMNS, "order": "created_at.desc", "limit": "50"}
        )
        return [self._session_meta(user, row) for row in rows or []]

    async def delete_session(self, user: User, session_id: str) -> bool:
        if await self._session_row(user, session_id, "id") is None:
            return False
        await self._call(user, "DELETE", "ip_sessions", params={"id": "eq." + session_id})
        return True

    async def search(self, user: User, session_id: str, query: str, k: int) -> List[str]:
        row = await self._session_row(user, session_id, "id,chunks_enc")
        if row is None:
            return []
        chunks = json.loads(self._open(row["chunks_enc"], "ip_sessions.chunks", user, session_id))
        if not chunks:
            return []
        # A resume is a handful of passages: exact search is instant.
        scores = embed(chunks) @ embed([query])[0]
        order = np.argsort(-scores, kind="stable")[: max(1, min(k, len(chunks)))]
        return [chunks[int(i)] for i in order]

    async def job_description(self, user: User, session_id: str) -> str:
        row = await self._session_row(user, session_id, "id,job_description_enc")
        return self._open(row["job_description_enc"], "ip_sessions.job_description", user, session_id) if row else ""

    # --- notes -------------------------------------------------------------------

    async def get_notes(self, user: User) -> str:
        rows = await self._call(user, "GET", "ip_profiles", params={"select": "notes_enc", "user_id": "eq." + user.id})
        return self._open(rows[0]["notes_enc"], "ip_profiles.notes", user, user.id) if rows else ""

    async def set_notes(self, user: User, notes: str) -> None:
        await self._call(
            user,
            "POST",
            "ip_profiles",
            params={"on_conflict": "user_id"},
            body={
                "user_id": user.id,
                "notes_enc": self._seal(notes[:MAX_NOTES], "ip_profiles.notes", user, user.id),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            },
            prefer="resolution=merge-duplicates,return=minimal",
        )

    # --- interviews ----------------------------------------------------------------

    def _open_interview(self, user: User, row: Dict[str, Any]) -> Dict[str, Any]:
        return json.loads(self._open(row["payload_enc"], "ip_interviews.payload", user, row["id"]))

    async def list_interviews(self, user: User) -> List[Dict[str, Any]]:
        rows = await self._call(
            user,
            "GET",
            "ip_interviews",
            params={"select": "id,payload_enc", "order": "started_at.desc", "limit": str(MAX_INTERVIEWS)},
        )
        return [self._open_interview(user, row) for row in rows or []]

    async def get_interview(self, user: User, interview_id: str) -> Optional[Dict[str, Any]]:
        rows = await self._call(
            user, "GET", "ip_interviews", params={"select": "id,payload_enc", "id": "eq." + interview_id}
        )
        return self._open_interview(user, rows[0]) if rows else None

    async def save_interview(self, user: User, payload: Dict[str, Any]) -> None:
        payload = validate_interview(payload)
        await self._call(
            user,
            "POST",
            "ip_interviews",
            params={"on_conflict": "user_id,id"},
            body={
                "id": payload["id"],
                "user_id": user.id,
                "started_at": payload["startedAt"],
                "payload_enc": self._seal(json.dumps(payload), "ip_interviews.payload", user, payload["id"]),
            },
            prefer="resolution=merge-duplicates,return=minimal",
        )

    async def clear_interviews(self, user: User) -> None:
        await self._call(user, "DELETE", "ip_interviews", params={"user_id": "eq." + user.id})

    async def delete_everything(self, user: User) -> None:
        for table in ("ip_interviews", "ip_sessions", "ip_profiles"):
            await self._call(user, "DELETE", table, params={"user_id": "eq." + user.id})
