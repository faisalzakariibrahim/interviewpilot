"""InterviewPilot backend.

Local mode (default): runs on this machine only (127.0.0.1) and keeps
everything in backend/data/.

    python -m uvicorn app.main:app --host 127.0.0.1 --port 8000

Cloud mode (INTERVIEWPILOT_MODE=cloud): every request needs a signed-in,
allowlisted Supabase user; data goes to your Supabase project, sealed with
DATA_ENCRYPTION_KEY. Required settings: SUPABASE_URL, SUPABASE_ANON_KEY,
DATA_ENCRYPTION_KEY, ALLOWED_EMAILS, ANTHROPIC_API_KEY.
"""

import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from dotenv import dotenv_values
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .auth import LOCAL_USER, LocalAuth, SupabaseAuth
from .billing import Billing, BillingError, build_billing_router, grant_guard
from .crypto import CryptoError, Sealer
from .routers.account import build_account_router
from .welcome import Welcomer, build_welcome_router
from .routers.jobs import build_jobs_router
from .routers.face_to_face import DEFAULT_MODEL, build_face_to_face_router, default_client_factory
from .routers.sessions import build_sessions_router
from .stores.base import Store, StoreError, User
from .stores.local import LocalStore

BACKEND_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = Path(os.getenv("INTERVIEWPILOT_ENV_FILE") or (BACKEND_DIR / ".env"))
CLOUD_SETTINGS = ("SUPABASE_URL", "SUPABASE_ANON_KEY", "DATA_ENCRYPTION_KEY", "ALLOWED_EMAILS")


def refresh_env() -> None:
    """Applies non-empty values from backend/.env. Safe to call on every request,
    so a key pasted into the file after start-up works without a restart."""
    if not ENV_FILE.is_file():
        return
    for key, value in dotenv_values(ENV_FILE).items():
        if value:
            os.environ[key] = value


def _misconfigured_app(problem: str) -> FastAPI:
    """Cloud mode with settings missing: answer every request with what's wrong, store nothing."""
    broken = FastAPI(title="InterviewPilot (not configured)")

    @broken.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
    async def not_configured(path: str) -> JSONResponse:
        return JSONResponse({"detail": "The server isn't configured: " + problem}, status_code=503)

    return broken


def create_app(
    mode: Optional[str] = None,
    store: Optional[Store] = None,
    auth: Any = None,
    billing: Optional[Billing] = None,
    welcomer: Optional[Welcomer] = None,
) -> FastAPI:
    refresh_env()
    mode = (mode or os.getenv("INTERVIEWPILOT_MODE") or "local").strip().lower()

    if mode == "cloud":
        missing = [name for name in CLOUD_SETTINGS if not os.getenv(name)]
        if missing and (store is None or auth is None):
            return _misconfigured_app("missing " + ", ".join(missing) + ".")
        if store is None:
            from .stores.supabase import SupabaseStore

            try:
                sealer = Sealer(os.getenv("DATA_ENCRYPTION_KEY"))
            except CryptoError as error:
                return _misconfigured_app(str(error))
            store = SupabaseStore(os.environ["SUPABASE_URL"], os.environ["SUPABASE_ANON_KEY"], sealer)
        if auth is None:
            auth = SupabaseAuth(
                os.environ["SUPABASE_URL"],
                os.environ["SUPABASE_ANON_KEY"],
                set((os.getenv("ALLOWED_EMAILS") or "").split(",")),
            )
    else:
        mode = "local"
        if store is None:
            data_dir = Path(os.getenv("INTERVIEWPILOT_DATA_DIR") or (BACKEND_DIR / "data"))
            store = LocalStore(data_dir)
        auth = auth or LocalAuth()

    if billing is None:
        # Charging is on only in cloud mode with INTERVIEWPILOT_BILLING=on.
        enabled = mode == "cloud" and (os.getenv("INTERVIEWPILOT_BILLING") or "").lower() in ("on", "1", "true")
        billing = Billing(
            enabled=enabled,
            supabase_url=os.getenv("SUPABASE_URL", ""),
            anon_key=os.getenv("SUPABASE_ANON_KEY", ""),
            service_key=os.getenv("SUPABASE_SERVICE_ROLE_KEY", ""),
            stripe_secret=os.getenv("STRIPE_SECRET_KEY", ""),
            webhook_secret=os.getenv("STRIPE_WEBHOOK_SECRET", ""),
            app_url=os.getenv("APP_URL", ""),
            currency=os.getenv("IP_CURRENCY", "usd"),
        )

    application = FastAPI(title="InterviewPilot", version="0.2.0", docs_url=None if mode == "cloud" else "/docs",
                          redoc_url=None, openapi_url=None if mode == "cloud" else "/openapi.json")

    @application.exception_handler(StoreError)
    async def store_error(request: Request, error: StoreError) -> JSONResponse:
        return JSONResponse({"detail": str(error)}, status_code=error.status)

    if mode == "local":
        # Only pages served from this machine may call the API directly.
        application.add_middleware(
            CORSMiddleware,
            allow_origin_regex=r"^http://(localhost|127\.0\.0\.1)(:\d+)?$",
            allow_methods=["GET", "POST", "PUT", "DELETE"],
            allow_headers=["Content-Type"],
        )
    # Cloud: the web app reaches this backend through its own server (a rewrite),
    # so browsers never call it cross-origin and no CORS is allowed.

    async def retrieve(user: User, session_id: str, query: str, k: int) -> List[str]:
        return await store.search(user, session_id, query, k)

    async def job_context(user: User, session_id: str) -> str:
        return await store.job_description(user, session_id)

    async def notes(user: User) -> str:
        return await store.get_notes(user)

    def client_factory() -> Any:
        refresh_env()
        return default_client_factory()

    async def count_job_fetch(user: User) -> None:
        try:
            await billing.count_job_fetch(user)
        except BillingError as error:
            raise HTTPException(status_code=error.status, detail=str(error)) from error

    application.include_router(build_sessions_router(store, auth))
    application.include_router(build_jobs_router(auth, client_factory, before_fetch=count_job_fetch))
    application.include_router(build_billing_router(billing, auth))
    application.include_router(build_account_router(store, auth, mode))
    if welcomer is not None or (mode == "cloud" and os.getenv("SUPABASE_URL")):
        application.include_router(
            build_welcome_router(
                welcomer or Welcomer(os.environ["SUPABASE_URL"], os.getenv("SUPABASE_ANON_KEY", ""), os.getenv("APP_URL", "")),
                auth,
            )
        )
    application.include_router(
        build_face_to_face_router(
            retrieve,
            job_context=job_context,
            notes=notes,
            client_factory=client_factory,
            current_user=auth,
            guard=grant_guard(billing, auth) if billing.enabled else None,
        )
    )

    @application.get("/api/health")
    async def health() -> Dict[str, Any]:
        refresh_env()
        body: Dict[str, Any] = {
            "ok": True,
            "mode": mode,
            "claude_configured": bool((os.getenv("ANTHROPIC_API_KEY") or "").strip()),
            "billing": billing.enabled,
        }
        if mode == "local":
            body.update(
                model=os.getenv("F2F_MODEL") or DEFAULT_MODEL,
                vector_index=store.engine,
                sessions=len(await store.list_sessions(LOCAL_USER)),
            )
        return body

    application.state.store = store
    application.state.mode = mode
    application.state.billing = billing
    return application


app = create_app()
