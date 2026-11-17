"""Practice sessions: a role, an optional job description, and an indexed resume."""

from typing import Any, Callable, List

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from pydantic import BaseModel

from ..resume_parser import MAX_BYTES, ResumeError, extract_text
from ..stores.base import SessionMeta, Store, StoreError, User
from .face_to_face import scrub_contact_details

MIN_RESUME_CHARACTERS = 150
MAX_JOB_DESCRIPTION = 20_000


class SessionOut(BaseModel):
    id: str
    role: str
    filename: str
    created_at: str
    passage_count: int
    has_job_description: bool


def _out(session: SessionMeta) -> SessionOut:
    return SessionOut(**session.__dict__)


def store_errors(error: StoreError) -> HTTPException:
    return HTTPException(status_code=error.status, detail=str(error))


def build_sessions_router(store: Store, current_user: Callable[..., Any]) -> APIRouter:
    router = APIRouter(prefix="/api/sessions", tags=["sessions"])
    who = Depends(current_user)

    @router.post("", response_model=SessionOut, status_code=201)
    async def create_session(
        role: str = Form(...),
        job_description: str = Form(""),
        resume: UploadFile = File(...),
        user: User = who,
    ) -> SessionOut:
        role = " ".join(role.split())
        if not 2 <= len(role) <= 200:
            raise HTTPException(status_code=422, detail="Enter the role you're practising for.")

        data = await resume.read(MAX_BYTES + 1)
        try:
            text = extract_text(resume.filename or "", data)
        except ResumeError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

        # Contact details are removed here, before the resume is indexed, so
        # they are never stored and never sent to Claude or the interviewer.
        text = scrub_contact_details(text)
        if len(text) < MIN_RESUME_CHARACTERS:
            raise HTTPException(
                status_code=422,
                detail="Couldn't read enough text from that file. If it's a scanned PDF, upload a DOCX or text copy.",
            )
        try:
            session = await store.create_session(
                user,
                role=role,
                job_description=scrub_contact_details(job_description)[:MAX_JOB_DESCRIPTION],
                filename=scrub_contact_details(resume.filename or "resume")[:200],
                text=text,
            )
        except StoreError as error:
            raise store_errors(error) from error
        except ValueError as error:  # no text to index
            raise HTTPException(status_code=422, detail="Couldn't read any text from that file.") from error
        return _out(session)

    @router.get("", response_model=List[SessionOut])
    async def list_sessions(user: User = who) -> List[SessionOut]:
        try:
            return [_out(session) for session in await store.list_sessions(user)]
        except StoreError as error:
            raise store_errors(error) from error

    @router.get("/{session_id}", response_model=SessionOut)
    async def get_session(session_id: str, user: User = who) -> SessionOut:
        try:
            session = await store.get_session(user, session_id)
        except StoreError as error:
            raise store_errors(error) from error
        if session is None:
            raise HTTPException(status_code=404, detail="That session is gone. Upload your resume again.")
        return _out(session)

    @router.delete("/{session_id}", status_code=204)
    async def delete_session(session_id: str, user: User = who) -> Response:
        try:
            deleted = await store.delete_session(user, session_id)
        except StoreError as error:
            raise store_errors(error) from error
        if not deleted:
            raise HTTPException(status_code=404, detail="That session is already gone.")
        return Response(status_code=204)

    return router
