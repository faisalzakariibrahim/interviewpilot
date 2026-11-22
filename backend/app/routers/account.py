"""Your notes, your interview history, and deleting everything."""

import json
import re
from typing import Any, Callable, Dict, List

from fastapi import APIRouter, Body, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from ..auth import user_ref
from ..stores.base import MAX_NOTES, Store, StoreError, User

# A 5-question interview with feedback and stronger answers is well under this.
MAX_INTERVIEW_BYTES = 200_000
from .face_to_face import scrub_contact_details
from .sessions import store_errors


class Notes(BaseModel):
    notes: str = Field(default="", max_length=MAX_NOTES)


def build_account_router(store: Store, current_user: Callable[..., Any], mode: str) -> APIRouter:
    router = APIRouter(prefix="/api", tags=["account"])
    who = Depends(current_user)

    @router.get("/me")
    async def me(user: User = who) -> Dict[str, Any]:
        # `ref` is what third parties (Nuance) see instead of who you are.
        return {"mode": mode, "ref": user_ref(user), "email": user.email}

    @router.get("/profile/notes", response_model=Notes)
    async def get_notes(user: User = who) -> Notes:
        try:
            return Notes(notes=await store.get_notes(user))
        except StoreError as error:
            raise store_errors(error) from error

    @router.put("/profile/notes", response_model=Notes)
    async def put_notes(body: Notes, user: User = who) -> Notes:
        # Notes go to Claude with every plan and score, so contact details are stripped.
        clean = scrub_contact_details(body.notes)[:MAX_NOTES]
        try:
            await store.set_notes(user, clean)
        except StoreError as error:
            raise store_errors(error) from error
        return Notes(notes=clean)

    @router.get("/interviews")
    async def list_interviews(user: User = who) -> List[Dict[str, Any]]:
        try:
            return await store.list_interviews(user)
        except StoreError as error:
            raise store_errors(error) from error

    @router.put("/interviews/{interview_id}")
    async def save_interview(interview_id: str, payload: Dict[str, Any] = Body(...), user: User = who) -> Dict[str, Any]:
        if payload.get("id") != interview_id:
            raise HTTPException(status_code=422, detail="The id in the path and the body differ.")
        if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", interview_id):
            raise HTTPException(status_code=422, detail="That interview id isn't valid.")
        if len(json.dumps(payload, default=str)) > MAX_INTERVIEW_BYTES:
            raise HTTPException(status_code=413, detail="That scorecard is too large to save.")
        try:
            await store.save_interview(user, payload)
        except StoreError as error:
            raise store_errors(error) from error
        return payload

    @router.delete("/interviews", status_code=204)
    async def clear_interviews(user: User = who) -> Response:
        try:
            await store.clear_interviews(user)
        except StoreError as error:
            raise store_errors(error) from error
        return Response(status_code=204)

    @router.delete("/account/data", status_code=204)
    async def delete_everything(user: User = who) -> Response:
        """Deletes every resume, note and interview this account has stored."""
        try:
            await store.delete_everything(user)
        except StoreError as error:
            raise store_errors(error) from error
        return Response(status_code=204)

    return router
