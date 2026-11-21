"""Who is asking.

Local mode: there is one person, the owner of this computer.
Cloud mode: the request must carry a Supabase access token; Supabase itself
confirms it (so a forged token fails), and the email must be on ALLOWED_EMAILS.
The database enforces the same allowlist again through row-level security.
"""

import hashlib
import time
from typing import Dict, Optional, Tuple

import httpx
from fastapi import HTTPException, Request

from .stores.base import User

LOCAL_USER = User(id="local")
_CACHE_SECONDS = 60


class SupabaseAuth:
    def __init__(
        self,
        url: str,
        anon_key: str,
        allowed_emails: set,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ) -> None:
        self.url = url.rstrip("/") + "/auth/v1/user"
        self.anon_key = anon_key
        # "*" opens the app to anyone who signs in (paid mode); otherwise only these emails.
        self.allowed = {email.strip().lower() for email in allowed_emails if email.strip()}
        self.transport = transport
        self._cache: Dict[str, Tuple[float, User]] = {}

    async def __call__(self, request: Request) -> User:
        header = request.headers.get("authorization", "")
        if not header.lower().startswith("bearer "):
            raise HTTPException(status_code=401, detail="Sign in first.")
        token = header[7:].strip()
        key = hashlib.sha256(token.encode()).hexdigest()
        cached = self._cache.get(key)
        if cached and cached[0] > time.monotonic():
            return cached[1]

        try:
            async with httpx.AsyncClient(timeout=10, transport=self.transport) as client:
                response = await client.get(
                    self.url, headers={"apikey": self.anon_key, "Authorization": "Bearer " + token}
                )
        except httpx.HTTPError as error:
            raise HTTPException(status_code=503, detail="Sign-in service unreachable.") from error
        if response.status_code != 200:
            raise HTTPException(status_code=401, detail="Your session expired. Sign in again.")
        data = response.json()
        email = str(data.get("email") or "").lower()
        open_signup = "*" in self.allowed
        if not data.get("id") or not email or (not open_signup and email not in self.allowed):
            # Same answer for every refusal: don't reveal who is allowed.
            raise HTTPException(status_code=403, detail="This account doesn't have access.")

        meta = data.get("user_metadata") or {}
        name = meta.get("first_name") or meta.get("given_name") or str(meta.get("full_name") or "").split(" ")[0]
        user = User(id=str(data["id"]), email=email, access_token=token, first_name=str(name or "").strip()[:40])
        if len(self._cache) > 500:
            self._cache.clear()
        self._cache[key] = (time.monotonic() + _CACHE_SECONDS, user)
        return user


class LocalAuth:
    async def __call__(self, request: Request) -> User:
        return LOCAL_USER


def user_ref(user: User) -> str:
    """A stable, non-reversible id for the user, for third parties such as Nuance."""
    return "ip_" + hashlib.sha256(("interviewpilot:" + user.id).encode()).hexdigest()[:40]
