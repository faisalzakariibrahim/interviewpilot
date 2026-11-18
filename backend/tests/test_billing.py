"""Paid mode: credits gate interviews, Stripe checkout and the signed webhook."""

import hashlib
import hmac
import json
import time
from typing import Any, Dict, List
from urllib.parse import parse_qs

import httpx
import pytest
from fastapi.testclient import TestClient

from app.auth import SupabaseAuth
from app.billing import Billing, Pack, verify_stripe_signature
from app.crypto import Sealer, generate_key
from app.main import create_app
from app.stores.supabase import SupabaseStore
from tests.test_cloud import ANON, TOKENS, URL, FakeSupabase

WEBHOOK_SECRET = "whsec_test"
SERVICE = "service-role-key"
PACKS = [Pack("single", "credits", 100, "Pay as you go", 50), Pack("monthly", "monthly", 1000, "Monthly")]


class FakeBackend(FakeSupabase):
    """Adds the billing RPCs and Stripe to the fake Supabase."""

    def __init__(self) -> None:
        super().__init__()
        self.credits: Dict[str, int] = {u["id"]: 0 for u in TOKENS.values()}
        self.grants: Dict[str, Dict[str, Any]] = {}
        self.purchases: set = set()
        self.stripe_calls: List[Dict[str, Any]] = []
        self.plans: Dict[str, Dict[str, Any]] = {}
        self.monthly_limit = 60

    def handler(self, request: httpx.Request) -> httpx.Response:
        if request.url.host == "api.stripe.com":
            assert request.headers["authorization"] == "Bearer sk_test_x"
            form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
            self.stripe_calls.append(form)
            if request.url.path.endswith("/billing_portal/sessions"):
                return httpx.Response(200, json={"url": "https://billing.stripe.com/p/session/x"})
            return httpx.Response(200, json={"id": "cs_123", "url": "https://checkout.stripe.com/c/pay/cs_123"})
        if "/rpc/" not in request.url.path:
            return super().handler(request)
        fn = request.url.path.rsplit("/", 1)[1]
        args = json.loads(request.content or b"{}")
        token = request.headers["authorization"][7:]
        if fn == "ip_set_subscription":
            if token != SERVICE:
                return httpx.Response(403, json={"message": "permission denied"})
            cur = self.plans.get(args["p_user_id"])
            if cur and cur["id"] == args["p_subscription_id"] and args["p_event_at"] < cur["at"]:
                return httpx.Response(200, json=False)
            self.plans[args["p_user_id"]] = {"id": args["p_subscription_id"], "customer": args["p_customer_id"],
                                            "status": args["p_status"], "end": args["p_period_end"], "at": args["p_event_at"],
                                            "used": cur["used"] if cur else 0}
            return httpx.Response(200, json=True)
        if fn == "ip_grant_credits":
            if token != SERVICE or request.headers["apikey"] != SERVICE:
                return httpx.Response(403, json={"message": "permission denied"})
            if args["p_session_id"] in self.purchases:
                return httpx.Response(200, json=False)
            self.purchases.add(args["p_session_id"])
            self.credits[args["p_user_id"]] += args["p_credits"]
            return httpx.Response(200, json=True)
        user = TOKENS.get(token)
        if not user:
            return httpx.Response(401, json={})
        admin = user["email"] == "me@example.com"
        plan = self.plans.get(user["id"])
        active = bool(plan and plan["status"] in ("active", "trialing"))
        if fn == "ip_account_status":
            out = None
            if plan:
                out = {"status": plan["status"], "active": active, "renews_at": plan["end"], "cancel_at_period_end": False,
                       "used": plan["used"], "limit": self.monthly_limit, "customer_id": plan["customer"]}
            return httpx.Response(200, json={"credits": self.credits[user["id"]], "unlimited": admin, "plan": out})
        if fn == "ip_start_interview":
            if not admin and active and plan["used"] < self.monthly_limit:
                plan["used"] += 1
            elif not admin:
                if active and self.credits[user["id"]] <= 0:
                    return httpx.Response(400, json={"message": "plan_limit", "code": "P0402"})
                if self.credits[user["id"]] <= 0:
                    return httpx.Response(400, json={"message": "no_credits", "code": "P0402"})
                self.credits[user["id"]] -= 1
            grant = "g{}".format(len(self.grants) + 1)
            self.grants[grant] = {"user": user["id"], "plan": 0, "score": 0, "call": 0, "answer": 0}
            return httpx.Response(200, json=grant)
        if fn == "ip_use_grant":
            g = self.grants.get(args["grant_id"])
            limits = {"plan": 2, "score": 40, "call": 3, "answer": 15}
            if not g or g["user"] != user["id"] or g[args["kind"]] >= limits[args["kind"]]:
                return httpx.Response(200, json=False)
            g[args["kind"]] += 1
            return httpx.Response(200, json=True)
        if fn == "ip_count_job_fetch":
            return httpx.Response(200, json=True)
        return httpx.Response(404)


@pytest.fixture()
def paid():
    fake = FakeBackend()
    transport = httpx.MockTransport(fake.handler)
    billing = Billing(
        enabled=True, supabase_url=URL, anon_key=ANON, service_key=SERVICE, stripe_secret="sk_test_x",
        webhook_secret=WEBHOOK_SECRET, app_url="https://app.example.com", packs=PACKS, transport=transport,
    )
    store = SupabaseStore(URL, ANON, Sealer(generate_key()), transport=transport)
    auth = SupabaseAuth(URL, ANON, {"*"}, transport=transport)
    return TestClient(create_app(mode="cloud", store=store, auth=auth, billing=billing)), fake


def h(token: str, grant: str = "") -> Dict[str, str]:
    headers = {"Authorization": "Bearer " + token}
    if grant:
        headers["X-Interview-Grant"] = grant
    return headers


def signed(event: Dict[str, Any], secret: str = WEBHOOK_SECRET, at: int = 0) -> Dict[str, Any]:
    payload = json.dumps(event).encode()
    t = at or int(time.time())
    sig = hmac.new(secret.encode(), str(t).encode() + b"." + payload, hashlib.sha256).hexdigest()
    return {"content": payload, "headers": {"Stripe-Signature": "t={},v1={}".format(t, sig)}}


def paid_event(user_id: str, session: str = "cs_1", amount: int = 300, pack: str = "single") -> Dict[str, Any]:
    return {
        "type": "checkout.session.completed",
        "data": {"object": {"id": session, "mode": "payment", "payment_status": "paid", "amount_total": amount,
                            "currency": "usd", "metadata": {"user_id": user_id, "pack": pack}}},
    }


def sub_event(user_id: str, status: str = "active", created: int = 0, amount: int = 1000, kind: str = "updated") -> Dict[str, Any]:
    return {
        "type": "customer.subscription." + kind,
        "created": created or int(time.time()),
        "data": {"object": {
            "id": "sub_1", "customer": "cus_1", "status": status, "cancel_at_period_end": False,
            "metadata": {"user_id": user_id, "pack": "monthly"},
            "items": {"data": [{"current_period_end": int(time.time()) + 30 * 86400,
                                "price": {"unit_amount": amount, "currency": "usd", "recurring": {"interval": "month"}}}]},
        }},
    }


OTHER = TOKENS["tok-other"]["id"]


def test_open_signup_but_no_credits_means_no_interview(paid) -> None:
    client, _ = paid
    assert client.get("/api/billing/status", headers=h("tok-stranger")).json() == {"enabled": True, "credits": 0, "unlimited": False, "plan": None}
    response = client.post("/api/billing/start", headers=h("tok-stranger"))
    assert response.status_code == 402 and "free interview" in response.json()["detail"]
    plan = client.post("/api/face-to-face/plan", json={"session_id": "x", "role": "GSOC"}, headers=h("tok-stranger"))
    assert plan.status_code == 402


def test_purchase_flow_end_to_end(paid) -> None:
    client, fake = paid
    url = client.post("/api/billing/checkout", json={"pack": "single"}, headers=h("tok-other")).json()["url"]
    assert url.startswith("https://checkout.stripe.com/")
    form = fake.stripe_calls[0]
    assert form["mode"] == "payment" and form["line_items[0][price_data][unit_amount]"] == "100"
    assert form["line_items[0][adjustable_quantity][maximum]"] == "50" and form["metadata[user_id]"] == OTHER
    assert form["success_url"] == "https://app.example.com/?checkout=success" and form["customer_email"] == "other@example.com"

    assert client.post("/api/stripe/webhook", **signed(paid_event(OTHER))).json()["credited"] is True
    assert client.post("/api/stripe/webhook", **signed(paid_event(OTHER))).json()["credited"] is False  # replay
    assert client.get("/api/billing/status", headers=h("tok-other")).json()["credits"] == 3

    grant = client.post("/api/billing/start", headers=h("tok-other")).json()["grant_id"]
    assert client.get("/api/billing/status", headers=h("tok-other")).json()["credits"] == 2
    call = client.post("/api/billing/authorize-call", headers=h("tok-other", grant))
    assert call.status_code == 200 and call.json()["ref"].startswith("ip_")
    # someone else can't ride on this grant
    assert client.post("/api/billing/authorize-call", headers=h("tok-me", grant)).status_code == 402
    # without a grant, paid endpoints refuse before calling Claude
    assert client.post("/api/billing/authorize-call", headers=h("tok-other")).status_code == 402


@pytest.mark.parametrize(
    "tamper",
    [
        lambda e: signed(e, secret="whsec_wrong"),
        lambda e: signed(e, at=int(time.time()) - 3600),
        lambda e: {"content": json.dumps(e).encode(), "headers": {"Stripe-Signature": "t=1,v1=abc"}},
    ],
)
def test_forged_or_stale_webhooks_add_nothing(paid, tamper) -> None:
    client, fake = paid
    assert client.post("/api/stripe/webhook", **tamper(paid_event(OTHER))).status_code == 400
    assert fake.credits[OTHER] == 0


def test_a_session_with_the_wrong_amount_adds_nothing(paid) -> None:
    client, fake = paid
    for amount in (1, 150, 5100):  # not whole dollars, or over the quantity limit
        assert client.post("/api/stripe/webhook", **signed(paid_event(OTHER, amount=amount))).status_code == 400
    assert fake.credits[OTHER] == 0


def test_unpaid_and_other_events_are_ignored(paid) -> None:
    client, fake = paid
    event = paid_event(OTHER)
    event["data"]["object"]["payment_status"] = "unpaid"
    assert client.post("/api/stripe/webhook", **signed(event)).json()["ignored"] == "unpaid"
    assert client.post("/api/stripe/webhook", **signed({"type": "invoice.paid", "data": {}})).json()["ignored"] == "invoice.paid"
    assert fake.credits[OTHER] == 0


def test_admin_is_unlimited(paid) -> None:
    client, _ = paid
    assert client.get("/api/billing/status", headers=h("tok-me")).json()["unlimited"] is True
    assert client.post("/api/billing/start", headers=h("tok-me")).status_code == 200


def test_packs_are_public_and_health_reports_billing(paid) -> None:
    client, _ = paid
    body = client.get("/api/billing/packs").json()
    assert [(p["kind"], p["price_cents"]) for p in body["packs"]] == [("credits", 100), ("monthly", 1000)]
    assert client.get("/api/health").json()["billing"] is True


def test_signature_helper() -> None:
    payload = b'{"a":1}'
    t = int(time.time())
    sig = hmac.new(b"s", str(t).encode() + b"." + payload, hashlib.sha256).hexdigest()
    assert verify_stripe_signature(payload, "t={},v1=bad,v1={}".format(t, sig), "s")
    assert not verify_stripe_signature(payload + b" ", "t={},v1={}".format(t, sig), "s")
    assert not verify_stripe_signature(payload, "garbage", "s")


def test_local_mode_never_charges(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("INTERVIEWPILOT_ENV_FILE", str(tmp_path / "none.env"))
    monkeypatch.setenv("INTERVIEWPILOT_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("INTERVIEWPILOT_BILLING", "on")  # ignored outside cloud mode
    client = TestClient(create_app(mode="local"))
    assert client.get("/api/billing/status").json()["enabled"] is False
    assert client.post("/api/billing/start").json() == {"grant_id": "local"}
    assert client.get("/api/billing/packs").json()["packs"] == []


def test_monthly_plan(paid) -> None:
    client, fake = paid
    form_url = client.post("/api/billing/checkout", json={"pack": "monthly"}, headers=h("tok-other")).json()["url"]
    assert form_url.startswith("https://checkout.stripe.com/")
    form = fake.stripe_calls[-1]
    assert form["mode"] == "subscription" and form["line_items[0][price_data][recurring][interval]"] == "month"
    assert form["line_items[0][price_data][unit_amount]"] == "1000" and form["subscription_data[metadata][user_id]"] == OTHER

    # the subscription checkout itself grants nothing; the subscription event does
    done = paid_event(OTHER, amount=1000, pack="monthly")
    done["data"]["object"]["mode"] = "subscription"
    assert "ignored" in client.post("/api/stripe/webhook", **signed(done)).json()
    assert client.post("/api/stripe/webhook", **signed(sub_event(OTHER, kind="created"))).json()["plan_updated"] is True
    status = client.get("/api/billing/status", headers=h("tok-other")).json()
    assert status["plan"]["active"] is True and "customer_id" not in status["plan"]

    # interviews on the plan don't touch credits; past the cap they need a credit
    fake.monthly_limit = 1
    assert client.post("/api/billing/start", headers=h("tok-other")).status_code == 200
    assert fake.credits[OTHER] == 0
    capped = client.post("/api/billing/start", headers=h("tok-other"))
    assert capped.status_code == 402 and "this month" in capped.json()["detail"]

    # can't buy a second plan; can manage the existing one
    assert client.post("/api/billing/checkout", json={"pack": "monthly"}, headers=h("tok-other")).status_code == 409
    portal = client.post("/api/billing/portal", headers=h("tok-other")).json()["url"]
    assert portal.startswith("https://billing.stripe.com/") and fake.stripe_calls[-1]["customer"] == "cus_1"

    # an old, delayed event doesn't undo a newer one; cancellation ends the plan
    assert client.post("/api/stripe/webhook", **signed(sub_event(OTHER, "canceled", created=1))).json()["plan_updated"] is False
    client.post("/api/stripe/webhook", **signed(sub_event(OTHER, "canceled", kind="deleted", created=int(time.time()) + 5)))
    assert client.get("/api/billing/status", headers=h("tok-other")).json()["plan"]["active"] is False


def test_a_subscription_at_the_wrong_price_is_refused(paid) -> None:
    client, fake = paid
    assert client.post("/api/stripe/webhook", **signed(sub_event(OTHER, amount=1))).status_code == 400
    assert OTHER not in fake.plans
    assert client.post("/api/billing/portal", headers=h("tok-other")).status_code == 404


def test_default_offer_is_the_monthly_plan_only(monkeypatch) -> None:
    from app.billing import load_packs
    monkeypatch.delenv("IP_PACKS", raising=False)
    assert [(p.kind, p.price_cents) for p in load_packs()] == [("monthly", 1000)]
