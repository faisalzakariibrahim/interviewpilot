"""Paid accounts: credits, interview grants and Stripe Checkout.

One credit = one interview. Starting an interview spends a credit and opens a
grant (45 minutes) that the plan, score, call and model-answer requests must
carry in the X-Interview-Grant header. The database functions in
supabase/billing.sql decide everything about credits; this module only calls
them with the signed-in user's own token. The single exception is the Stripe
webhook, which adds credits with the service-role key after verifying Stripe's
signature.

Card details never reach this server: Stripe Checkout collects them.
"""

import hashlib
import hmac
import json
import os
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field

from .auth import user_ref
from .stores.base import User

def stripe_api() -> str:
    """Stripe's API base. STRIPE_API_BASE exists only for local tests against a fake."""
    return (os.getenv("STRIPE_API_BASE") or "https://api.stripe.com/v1").rstrip("/")
GRANT_HEADER = "x-interview-grant"
SIGNATURE_TOLERANCE_SECONDS = 300

DEFAULT_PACKS = [
    {"id": "starter", "credits": 3, "price_cents": 900, "label": "3 interviews"},
    {"id": "standard", "credits": 10, "price_cents": 2400, "label": "10 interviews"},
    {"id": "pro", "credits": 25, "price_cents": 4900, "label": "25 interviews"},
]


@dataclass
class Pack:
    id: str
    credits: int
    price_cents: int
    label: str


def load_packs() -> List[Pack]:
    raw = os.getenv("IP_PACKS")
    try:
        items = json.loads(raw) if raw else DEFAULT_PACKS
        packs = [Pack(str(i["id"]), int(i["credits"]), int(i["price_cents"]), str(i.get("label") or "")) for i in items]
    except (ValueError, KeyError, TypeError):
        packs = [Pack(**p) for p in DEFAULT_PACKS]  # type: ignore[arg-type]
    return [p for p in packs if 0 < p.credits <= 500 and p.price_cents >= 50]


def verify_stripe_signature(payload: bytes, header: str, secret: str, now: Optional[float] = None) -> bool:
    """Stripe's scheme: HMAC-SHA256 of "<t>.<payload>", within a 5-minute window."""
    try:
        parts = dict(item.split("=", 1) for item in header.split(",") if "=" in item)
        timestamp = int(parts.get("t", "0"))
    except ValueError:
        return False
    signatures = [item.split("=", 1)[1] for item in header.split(",") if item.startswith("v1=")]
    if not signatures or abs((now or time.time()) - timestamp) > SIGNATURE_TOLERANCE_SECONDS:
        return False
    expected = hmac.new(secret.encode(), str(timestamp).encode() + b"." + payload, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, sig) for sig in signatures)


class BillingError(Exception):
    def __init__(self, message: str, status: int) -> None:
        super().__init__(message)
        self.status = status


class Billing:
    """Talks to the database functions and to Stripe. `enabled` False means no charging (local mode)."""

    def __init__(
        self,
        enabled: bool,
        supabase_url: str = "",
        anon_key: str = "",
        service_key: str = "",
        stripe_secret: str = "",
        webhook_secret: str = "",
        app_url: str = "",
        currency: str = "usd",
        packs: Optional[List[Pack]] = None,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ) -> None:
        self.enabled = enabled
        self.rest = supabase_url.rstrip("/") + "/rest/v1"
        self.anon_key = anon_key
        self.service_key = service_key.strip()
        self.stripe_secret = stripe_secret.strip()
        self.webhook_secret = webhook_secret.strip()
        self.app_url = app_url.rstrip("/")
        self.currency = currency.lower()
        self.packs = packs if packs is not None else load_packs()
        self.transport = transport

    # --- database ----------------------------------------------------------------

    async def _rpc(self, function: str, args: Dict[str, Any], token: str, key: str) -> httpx.Response:
        try:
            async with httpx.AsyncClient(timeout=15, transport=self.transport) as client:
                return await client.post(
                    "{}/rpc/{}".format(self.rest, function),
                    json=args,
                    headers={"apikey": key, "Authorization": "Bearer " + token, "Content-Type": "application/json"},
                )
        except httpx.HTTPError as error:
            raise BillingError("The database isn't reachable right now.", 503) from error

    async def _user_rpc(self, user: User, function: str, args: Optional[Dict[str, Any]] = None) -> Any:
        response = await self._rpc(function, args or {}, user.access_token or "", self.anon_key)
        if response.status_code == 200:
            return response.json()
        if "no_credits" in response.text:
            raise BillingError("You're out of interviews. Buy more to keep practising.", 402)
        if response.status_code in (401, 403):
            raise BillingError("Your session expired. Sign in again.", 401)
        raise BillingError("The account service refused the request ({}).".format(response.status_code), 502)

    async def status(self, user: User) -> Dict[str, Any]:
        if not self.enabled:
            return {"enabled": False, "credits": 0, "unlimited": True}
        data = await self._user_rpc(user, "ip_account_status")
        return {"enabled": True, "credits": int(data.get("credits", 0)), "unlimited": bool(data.get("unlimited"))}

    async def start(self, user: User) -> str:
        if not self.enabled:
            return "local"
        return str(await self._user_rpc(user, "ip_start_interview"))

    async def use(self, user: User, grant_id: Optional[str], kind: str) -> None:
        if not self.enabled:
            return
        if not grant_id:
            raise BillingError("Start an interview first.", 402)
        allowed = await self._user_rpc(user, "ip_use_grant", {"grant_id": grant_id, "kind": kind})
        if allowed is not True:
            raise BillingError(
                "This interview's limit is used up or it has expired." if kind != "answer"
                else "This interview's stronger answers are used up.",
                402,
            )

    async def count_job_fetch(self, user: User) -> None:
        if not self.enabled:
            return
        if await self._user_rpc(user, "ip_count_job_fetch") is not True:
            raise BillingError("You've read the maximum number of job links for today. Paste the description instead.", 429)

    # --- Stripe ------------------------------------------------------------------------

    def pack(self, pack_id: str) -> Pack:
        for pack in self.packs:
            if pack.id == pack_id:
                return pack
        raise BillingError("Unknown pack.", 422)

    async def checkout(self, user: User, pack_id: str) -> str:
        if not self.enabled:
            raise BillingError("Payments aren't enabled here.", 404)
        if not self.stripe_secret or not self.app_url:
            raise BillingError("Payments aren't set up yet.", 503)
        pack = self.pack(pack_id)
        form = {
            "mode": "payment",
            "line_items[0][quantity]": "1",
            "line_items[0][price_data][currency]": self.currency,
            "line_items[0][price_data][unit_amount]": str(pack.price_cents),
            "line_items[0][price_data][product_data][name]": "InterviewPilot: {}".format(pack.label or "{} interviews".format(pack.credits)),
            "success_url": self.app_url + "/?checkout=success",
            "cancel_url": self.app_url + "/?checkout=cancelled",
            "client_reference_id": user.id,
            "metadata[user_id]": user.id,
            "metadata[pack]": pack.id,
            "metadata[credits]": str(pack.credits),
        }
        if user.email:
            form["customer_email"] = user.email
        try:
            async with httpx.AsyncClient(timeout=20, transport=self.transport) as client:
                response = await client.post(
                    stripe_api() + "/checkout/sessions",
                    data=form,
                    headers={"Authorization": "Bearer " + self.stripe_secret},
                )
        except httpx.HTTPError as error:
            raise BillingError("Stripe isn't reachable right now.", 503) from error
        if response.status_code != 200:
            raise BillingError("Stripe couldn't start checkout ({}).".format(response.status_code), 502)
        url = str(response.json().get("url") or "")
        host = str(urlsplit(url).hostname)
        if host != "checkout.stripe.com" and not host.endswith(".stripe.com") and not os.getenv("STRIPE_API_BASE"):
            raise BillingError("Stripe returned an unexpected checkout address.", 502)
        return url

    async def handle_webhook(self, payload: bytes, signature: str) -> Dict[str, Any]:
        if not self.webhook_secret or not self.service_key:
            raise BillingError("Webhook isn't set up.", 503)
        if not verify_stripe_signature(payload, signature, self.webhook_secret):
            raise BillingError("Bad signature.", 400)
        event = json.loads(payload)
        if event.get("type") not in ("checkout.session.completed", "checkout.session.async_payment_succeeded"):
            return {"received": True, "ignored": event.get("type")}
        session = (event.get("data") or {}).get("object") or {}
        if session.get("payment_status") != "paid":
            return {"received": True, "ignored": "unpaid"}
        metadata = session.get("metadata") or {}
        pack = self.pack(str(metadata.get("pack", "")))
        # The amount Stripe actually charged must match the pack, so a tampered session can't mint credits.
        if int(session.get("amount_total") or -1) != pack.price_cents or str(session.get("currency", "")).lower() != self.currency:
            raise BillingError("Amount doesn't match the pack.", 400)
        response = await self._rpc(
            "ip_grant_credits",
            {
                "p_session_id": str(session["id"]),
                "p_user_id": str(metadata["user_id"]),
                "p_credits": pack.credits,
                "p_amount_cents": pack.price_cents,
                "p_currency": self.currency,
            },
            self.service_key,
            self.service_key,
        )
        if response.status_code != 200:
            raise BillingError("Couldn't record the purchase.", 500)  # Stripe retries
        return {"received": True, "credited": response.json() is True}


class PackOut(BaseModel):
    id: str
    credits: int
    price_cents: int
    label: str


class CheckoutRequest(BaseModel):
    pack: str = Field(min_length=1, max_length=40)


def build_billing_router(billing: Billing, current_user: Callable[..., Any]) -> APIRouter:
    router = APIRouter(tags=["billing"])
    who = Depends(current_user)

    def fail(error: BillingError) -> HTTPException:
        return HTTPException(status_code=error.status, detail=str(error))

    @router.get("/api/billing/packs")
    async def packs() -> Dict[str, Any]:
        return {
            "enabled": billing.enabled,
            "currency": billing.currency,
            "packs": [PackOut(**p.__dict__).model_dump() for p in billing.packs] if billing.enabled else [],
        }

    @router.get("/api/billing/status")
    async def status(user: User = who) -> Dict[str, Any]:
        try:
            return await billing.status(user)
        except BillingError as error:
            raise fail(error) from error

    @router.post("/api/billing/checkout")
    async def checkout(body: CheckoutRequest, user: User = who) -> Dict[str, str]:
        try:
            return {"url": await billing.checkout(user, body.pack)}
        except BillingError as error:
            raise fail(error) from error

    @router.post("/api/billing/start")
    async def start(user: User = who) -> Dict[str, str]:
        try:
            return {"grant_id": await billing.start(user)}
        except BillingError as error:
            raise fail(error) from error

    @router.post("/api/billing/authorize-call")
    async def authorize_call(
        user: User = who, grant: Optional[str] = Header(default=None, alias=GRANT_HEADER)
    ) -> Dict[str, str]:
        """For the web app's server, before it mints an interviewer token."""
        try:
            await billing.use(user, grant, "call")
        except BillingError as error:
            raise fail(error) from error
        return {"ref": user_ref(user)}

    @router.post("/api/stripe/webhook")
    async def webhook(request: Request) -> Dict[str, Any]:
        payload = await request.body()
        try:
            return await billing.handle_webhook(payload, request.headers.get("stripe-signature", ""))
        except BillingError as error:
            raise fail(error) from error

    return router


def grant_guard(billing: Billing, current_user: Callable[..., Any]) -> Callable[[str], Callable[..., Any]]:
    """Makes a FastAPI dependency per kind: plan, score or answer."""

    def factory(kind: str) -> Callable[..., Any]:
        async def dependency(
            user: User = Depends(current_user),
            grant: Optional[str] = Header(default=None, alias=GRANT_HEADER),
        ) -> None:
            try:
                await billing.use(user, grant, kind)
            except BillingError as error:
                raise HTTPException(status_code=error.status, detail=str(error)) from error

        return dependency

    return factory
