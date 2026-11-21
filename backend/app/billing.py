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

from datetime import datetime, timezone
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

# Every account starts with 3 free interviews (set in the database: ip_private.settings 'free_credits').
# "monthly": a subscription; interviews are included while it's active, up to the monthly_limit
#   set in the database (ip_private.settings, default 60).
# "credits": optional one-time purchase (credits = quantity picked at checkout). Off by default;
#   add one through IP_PACKS to sell single interviews again.
DEFAULT_PACKS = [
    {"id": "monthly", "kind": "monthly", "price_cents": 1000, "label": "Monthly"},
]
SUBSCRIPTION_EVENTS = ("customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted")


@dataclass
class Pack:
    id: str
    kind: str
    price_cents: int
    label: str
    max_quantity: int = 1


def load_packs() -> List[Pack]:
    raw = os.getenv("IP_PACKS")
    try:
        items = json.loads(raw) if raw else DEFAULT_PACKS
        packs = [
            Pack(str(i["id"]), str(i["kind"]), int(i["price_cents"]), str(i.get("label") or ""), int(i.get("max_quantity") or 1))
            for i in items
        ]
    except (ValueError, KeyError, TypeError):
        packs = [Pack(**p) for p in DEFAULT_PACKS]  # type: ignore[arg-type]
    packs = [p for p in packs if p.kind in ("credits", "monthly") and p.price_cents >= 50 and 1 <= p.max_quantity <= 500]
    monthly = [p for p in packs if p.kind == "monthly"][:1]  # at most one monthly plan
    return [p for p in packs if p.kind == "credits"] + monthly


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
        if "plan_limit" in response.text:
            raise BillingError("You've used this month's interviews on your plan. They reset when it renews.", 402)
        if "no_credits" in response.text:
            raise BillingError("You've used your 3 free interviews. Subscribe to keep practising.", 402)
        if "not_admin" in response.text:
            raise BillingError("Only the owner can see this page.", 403)
        if response.status_code in (401, 403):
            raise BillingError("Your session expired. Sign in again.", 401)
        raise BillingError("The account service refused the request ({}).".format(response.status_code), 502)

    async def _account(self, user: User) -> Dict[str, Any]:
        return await self._user_rpc(user, "ip_account_status")

    async def status(self, user: User) -> Dict[str, Any]:
        if not self.enabled:
            return {"enabled": False, "credits": 0, "unlimited": True, "plan": None}
        data = await self._account(user)
        plan = data.get("plan")
        if plan:  # the Stripe customer id stays on the server
            plan = {k: plan.get(k) for k in ("status", "active", "renews_at", "cancel_at_period_end", "used", "limit")}
        return {"enabled": True, "credits": int(data.get("credits", 0)), "unlimited": bool(data.get("unlimited")), "plan": plan}

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

    async def admin_overview(self, user: User) -> Dict[str, Any]:
        """Owner dashboard numbers. The database refuses anyone who isn't in ip_admins."""
        if not self.enabled:
            raise BillingError("The admin page needs the cloud version with payments on.", 404)
        data = await self._user_rpc(user, "ip_admin_overview")
        monthly = next((p for p in self.packs if p.kind == "monthly"), None)
        totals = data.setdefault("totals", {})
        totals["monthly_revenue_cents"] = int(totals.get("subscribers") or 0) * (monthly.price_cents if monthly else 0)
        data["currency"] = self.currency
        return data

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

    async def _stripe(self, path: str, form: Dict[str, str]) -> Dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=20, transport=self.transport) as client:
                response = await client.post(
                    stripe_api() + path, data=form, headers={"Authorization": "Bearer " + self.stripe_secret}
                )
        except httpx.HTTPError as error:
            raise BillingError("Stripe isn't reachable right now.", 503) from error
        if response.status_code != 200:
            raise BillingError("Stripe refused the request ({}).".format(response.status_code), 502)
        return response.json()

    @staticmethod
    def _stripe_url(url: str) -> str:
        host = str(urlsplit(url).hostname)
        if host != "checkout.stripe.com" and host != "billing.stripe.com" and not host.endswith(".stripe.com") and not os.getenv("STRIPE_API_BASE"):
            raise BillingError("Stripe returned an unexpected address.", 502)
        return url

    def _ready(self) -> None:
        if not self.enabled:
            raise BillingError("Payments aren't enabled here.", 404)
        if not self.stripe_secret or not self.app_url:
            raise BillingError("Payments aren't set up yet.", 503)

    async def checkout(self, user: User, pack_id: str) -> str:
        self._ready()
        pack = self.pack(pack_id)
        form = {
            "line_items[0][quantity]": "1",
            "line_items[0][price_data][currency]": self.currency,
            "line_items[0][price_data][unit_amount]": str(pack.price_cents),
            "success_url": self.app_url + "/?checkout=success",
            "cancel_url": self.app_url + "/?checkout=cancelled",
            "client_reference_id": user.id,
            "metadata[user_id]": user.id,
            "metadata[pack]": pack.id,
        }
        if pack.kind == "monthly":
            plan = (await self._account(user)).get("plan") or {}
            if plan.get("active"):
                raise BillingError("You already have the monthly plan. Manage it from your account.", 409)
            form.update({
                "mode": "subscription",
                "line_items[0][price_data][product_data][name]": "InterviewPilot monthly plan",
                "line_items[0][price_data][recurring][interval]": "month",
                "subscription_data[metadata][user_id]": user.id,
                "subscription_data[metadata][pack]": pack.id,
            })
        else:
            form.update({
                "mode": "payment",
                "line_items[0][price_data][product_data][name]": "InterviewPilot interview",
                "line_items[0][adjustable_quantity][enabled]": "true",
                "line_items[0][adjustable_quantity][minimum]": "1",
                "line_items[0][adjustable_quantity][maximum]": str(pack.max_quantity),
            })
        if user.email:
            form["customer_email"] = user.email
        return self._stripe_url(str((await self._stripe("/checkout/sessions", form)).get("url") or ""))

    async def portal(self, user: User) -> str:
        """Stripe's own page for cancelling the plan or changing the card."""
        self._ready()
        plan = (await self._account(user)).get("plan") or {}
        if not plan.get("customer_id"):
            raise BillingError("You don't have a monthly plan.", 404)
        form = {"customer": str(plan["customer_id"]), "return_url": self.app_url + "/"}
        # Set by deploy-cloud.sh, which creates the portal settings through Stripe's API.
        config = (os.getenv("STRIPE_PORTAL_CONFIG") or "").strip()
        if config:
            form["configuration"] = config
        answer = await self._stripe("/billing_portal/sessions", form)
        return self._stripe_url(str(answer.get("url") or ""))

    async def _service_rpc(self, function: str, args: Dict[str, Any]) -> Any:
        response = await self._rpc(function, args, self.service_key, self.service_key)
        if response.status_code != 200:
            raise BillingError("Couldn't record the payment.", 500)  # Stripe retries
        return response.json()

    async def handle_webhook(self, payload: bytes, signature: str) -> Dict[str, Any]:
        if not self.webhook_secret or not self.service_key:
            raise BillingError("Webhook isn't set up.", 503)
        if not verify_stripe_signature(payload, signature, self.webhook_secret):
            raise BillingError("Bad signature.", 400)
        event = json.loads(payload)
        kind = event.get("type")
        obj = (event.get("data") or {}).get("object") or {}
        if kind in SUBSCRIPTION_EVENTS:
            return await self._subscription_event(obj, int(event.get("created") or time.time()))
        if kind not in ("checkout.session.completed", "checkout.session.async_payment_succeeded"):
            return {"received": True, "ignored": kind}
        if obj.get("mode") == "subscription":
            return {"received": True, "ignored": "subscription checkout (handled by subscription events)"}
        if obj.get("payment_status") != "paid":
            return {"received": True, "ignored": "unpaid"}
        metadata = obj.get("metadata") or {}
        pack = self.pack(str(metadata.get("pack", "")))
        amount = int(obj.get("amount_total") or -1)
        # Credits come from what Stripe actually charged, so a tampered session can't mint more.
        if pack.kind != "credits" or str(obj.get("currency", "")).lower() != self.currency:
            raise BillingError("Payment doesn't match a credit pack.", 400)
        if amount <= 0 or amount % pack.price_cents or not 1 <= amount // pack.price_cents <= pack.max_quantity:
            raise BillingError("Amount doesn't match the price.", 400)
        credited = await self._service_rpc("ip_grant_credits", {
            "p_session_id": str(obj["id"]),
            "p_user_id": str(metadata["user_id"]),
            "p_credits": amount // pack.price_cents,
            "p_amount_cents": amount,
            "p_currency": self.currency,
        })
        return {"received": True, "credited": credited is True}

    async def _subscription_event(self, sub: Dict[str, Any], created: int) -> Dict[str, Any]:
        user_id = str((sub.get("metadata") or {}).get("user_id") or "")
        if not user_id:
            return {"received": True, "ignored": "not ours"}
        items = ((sub.get("items") or {}).get("data") or [{}])
        price = items[0].get("price") or {}
        monthly = next((p for p in self.packs if p.kind == "monthly"), None)
        if (
            monthly is None
            or int(price.get("unit_amount") or -1) != monthly.price_cents
            or str(price.get("currency", "")).lower() != self.currency
            or (price.get("recurring") or {}).get("interval") != "month"
        ):
            raise BillingError("Subscription doesn't match the monthly plan.", 400)
        # Newer Stripe API versions keep the period on the item, older ones on the subscription.
        period_end = items[0].get("current_period_end") or sub.get("current_period_end")
        if not period_end:
            raise BillingError("Subscription has no billing period.", 400)
        applied = await self._service_rpc("ip_set_subscription", {
            "p_user_id": user_id,
            "p_subscription_id": str(sub["id"]),
            "p_customer_id": str(sub.get("customer") or ""),
            "p_status": str(sub.get("status") or ""),
            "p_period_end": datetime.fromtimestamp(int(period_end), tz=timezone.utc).isoformat(),
            "p_cancel_at_period_end": bool(sub.get("cancel_at_period_end")),
            "p_event_at": datetime.fromtimestamp(created, tz=timezone.utc).isoformat(),
        })
        return {"received": True, "plan_updated": applied is True}


class PackOut(BaseModel):
    id: str
    kind: str
    price_cents: int
    label: str
    max_quantity: int


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
            # Shown on the price card. The cap itself is enforced by the database
            # (ip_private.settings 'monthly_limit'); keep the two equal.
            "monthly_limit": int(os.getenv("IP_MONTHLY_LIMIT") or 15),
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

    @router.post("/api/billing/portal")
    async def portal(user: User = who) -> Dict[str, str]:
        try:
            return {"url": await billing.portal(user)}
        except BillingError as error:
            raise fail(error) from error

    @router.get("/api/admin/overview")
    async def admin_overview(user: User = who) -> Dict[str, Any]:
        try:
            return await billing.admin_overview(user)
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
        user: User = who,
        grant: Optional[str] = Header(default=None, alias=GRANT_HEADER),
        confirm: bool = False,
    ) -> Dict[str, str]:
        """For the web app's server. Without `confirm`: may this interview start a video call?
        With `confirm=true`, after Nuance actually started one: count it. An interview whose
        calls never started is refunded when it expires."""
        try:
            await billing.use(user, grant, "call" if confirm else "call_check")
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
