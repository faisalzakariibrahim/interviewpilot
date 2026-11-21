"""The welcome email: sent once per account, right after their first sign-in.

Uses any SMTP server; the defaults fit Gmail with an app password (the same one Supabase uses
for sign-in emails). Settings: SMTP_USER and SMTP_PASSWORD (required), SMTP_HOST (default
smtp.gmail.com), SMTP_PORT (587), SMTP_FROM (defaults to SMTP_USER), APP_URL.
Without SMTP_USER/SMTP_PASSWORD nothing is sent and nothing is marked as sent.
"""

from __future__ import annotations

import asyncio
import html
import os
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from typing import Any, Callable, Dict, Optional

import httpx
from fastapi import APIRouter, Depends

from .stores.base import User


def smtp_settings() -> Optional[Dict[str, Any]]:
    user = (os.getenv("SMTP_USER") or "").strip()
    password = (os.getenv("SMTP_PASSWORD") or "").replace(" ", "").strip()
    if not user or not password:
        return None
    return {
        "host": (os.getenv("SMTP_HOST") or "smtp.gmail.com").strip(),
        "port": int(os.getenv("SMTP_PORT") or 587),
        "user": user,
        "password": password,
        "from": (os.getenv("SMTP_FROM") or user).strip(),
    }


def build_message(to: str, first_name: str, app_url: str, sender: str) -> EmailMessage:
    name = first_name.strip() or "there"
    url = app_url or "https://interviewpilot-eight.vercel.app"
    text = (
        f"Hi {name},\n\n"
        "Welcome to InterviewPilot! Your first 3 face-to-face mock interviews are free.\n\n"
        "How it works:\n"
        "1. Upload your resume and the job you want (a job link works too).\n"
        "2. A video AI interviewer asks questions built from your experience and follows up like a real hiring manager.\n"
        "3. Get a scorecard for every answer, with a stronger version built only from your own experience.\n\n"
        f"Start your free interviews: {url}\n\n"
        "After that, the monthly plan is $10 a month for up to 60 interviews, and you can cancel any time.\n\n"
        "Good luck with your next interview!\n"
        "The InterviewPilot team\n\n"
        "You're getting this one-time email because you just created an InterviewPilot account."
    )
    safe = html.escape(name)
    link = html.escape(url, quote=True)
    body = f"""<!doctype html><html><body style="margin:0;background:#f4f6fb;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1b2333">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:14px;padding:28px">
<tr><td>
<p style="margin:0 0 18px;font-weight:700;font-size:18px">InterviewPilot</p>
<h1 style="margin:0 0 12px;font-size:22px">Welcome, {safe}!</h1>
<p style="margin:0 0 16px;line-height:1.55">Your first <strong>3 face-to-face mock interviews are free</strong>. Here's how it works:</p>
<ol style="margin:0 0 20px;padding-left:20px;line-height:1.6">
<li>Upload your resume and the job you want (a job link works too).</li>
<li>A video AI interviewer asks questions built from your experience and follows up like a real hiring manager.</li>
<li>Get a scorecard for every answer, with a stronger version built only from your own experience.</li>
</ol>
<p style="margin:0 0 22px"><a href="{link}" style="display:inline-block;background:#3d6bff;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:10px">Start your free interviews</a></p>
<p style="margin:0 0 16px;line-height:1.55;color:#4a5568">After that, the monthly plan is $10 a month for up to 60 interviews. Cancel any time.</p>
<p style="margin:0;line-height:1.55">Good luck with your next interview!<br>The InterviewPilot team</p>
</td></tr></table>
<p style="font-size:12px;color:#8a94a6;max-width:520px;margin:14px auto 0">You're getting this one-time email because you just created an InterviewPilot account.</p>
</td></tr></table></body></html>"""
    message = EmailMessage()
    message["Subject"] = f"Welcome to InterviewPilot, {name}: your first 3 interviews are free"
    message["From"] = formataddr(("InterviewPilot", sender))
    message["To"] = to
    message["Message-ID"] = make_msgid(domain=sender.split("@")[-1] or None)
    message.set_content(text)
    message.add_alternative(body, subtype="html")
    return message


def send(message: EmailMessage, settings: Dict[str, Any]) -> None:
    context = ssl.create_default_context()
    if settings["port"] == 465:
        with smtplib.SMTP_SSL(settings["host"], settings["port"], context=context, timeout=20) as server:
            server.login(settings["user"], settings["password"])
            server.send_message(message)
    else:
        with smtplib.SMTP(settings["host"], settings["port"], timeout=20) as server:
            server.starttls(context=context)
            server.login(settings["user"], settings["password"])
            server.send_message(message)


class Welcomer:
    """Claims the once-per-account flag in the database, then sends."""

    def __init__(self, supabase_url: str, anon_key: str, app_url: str = "",
                 sender: Callable[[EmailMessage, Dict[str, Any]], None] = send,
                 transport: Optional[httpx.AsyncBaseTransport] = None) -> None:
        self.rest = supabase_url.rstrip("/") + "/rest/v1"
        self.anon_key = anon_key
        self.app_url = app_url.rstrip("/")
        self.sender = sender
        self.transport = transport

    async def _rpc(self, user: User, function: str) -> Any:
        async with httpx.AsyncClient(timeout=15, transport=self.transport) as client:
            response = await client.post(
                "{}/rpc/{}".format(self.rest, function),
                json={},
                headers={"apikey": self.anon_key, "Authorization": "Bearer " + (user.access_token or ""),
                         "Content-Type": "application/json"},
            )
        return response.json() if response.status_code == 200 and response.content else None

    async def welcome(self, user: User) -> Dict[str, Any]:
        settings = smtp_settings()
        if not settings:
            return {"sent": False, "reason": "email not set up"}
        if not user.email:
            return {"sent": False, "reason": "no email"}
        if await self._rpc(user, "ip_claim_welcome") is not True:
            return {"sent": False, "reason": "already welcomed"}
        message = build_message(user.email, user.first_name, self.app_url, settings["from"])
        try:
            await asyncio.to_thread(self.sender, message, settings)
        except Exception:  # noqa: BLE001 - let it retry next sign-in
            await self._rpc(user, "ip_release_welcome")
            return {"sent": False, "reason": "couldn't send"}
        return {"sent": True}


def build_welcome_router(welcomer: Welcomer, current_user: Callable[..., Any]) -> APIRouter:
    router = APIRouter(tags=["account"])

    @router.post("/api/account/welcome")
    async def welcome(user: User = Depends(current_user)) -> Dict[str, Any]:
        """Sends this account its one welcome email, to its own address only."""
        return await welcomer.welcome(user)

    return router
