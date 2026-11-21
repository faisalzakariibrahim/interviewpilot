"""Welcome email: once per account, only to the account's own address, never without SMTP."""

import httpx
import pytest
from fastapi.testclient import TestClient

from app.auth import SupabaseAuth
from app.billing import Billing
from app.crypto import Sealer, generate_key
from app.main import create_app
from app.stores.supabase import SupabaseStore
from app.welcome import Welcomer, build_message
from tests.test_cloud import ANON, TOKENS, URL, FakeSupabase


class WelcomeBackend(FakeSupabase):
    def __init__(self) -> None:
        super().__init__()
        self.welcomed: set = set()

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/auth/v1/user"):
            user = TOKENS.get(request.headers.get("authorization", "")[7:])
            if not user:
                return httpx.Response(401, json={})
            return httpx.Response(200, json={**user, "user_metadata": {"first_name": "Tariq<b>"}})
        if path.endswith("/rpc/ip_claim_welcome"):
            uid = TOKENS[request.headers["authorization"][7:]]["id"]
            if uid in self.welcomed:
                return httpx.Response(200, json=False)
            self.welcomed.add(uid)
            return httpx.Response(200, json=True)
        if path.endswith("/rpc/ip_release_welcome"):
            self.welcomed.discard(TOKENS[request.headers["authorization"][7:]]["id"])
            return httpx.Response(200, content=b"")
        return super().handler(request)


@pytest.fixture()
def app_with(monkeypatch):
    def make(fail: bool = False, smtp: bool = True):
        if smtp:
            monkeypatch.setenv("SMTP_USER", "interviewpilot.app@gmail.com")
            monkeypatch.setenv("SMTP_PASSWORD", "abcd efgh ijkl mnop")
        else:
            monkeypatch.delenv("SMTP_USER", raising=False)
            monkeypatch.delenv("SMTP_PASSWORD", raising=False)
        fake = WelcomeBackend()
        sent = []

        def sender(message, settings):
            if fail:
                raise OSError("smtp down")
            sent.append((message, settings))

        transport = httpx.MockTransport(fake.handler)
        welcomer = Welcomer(URL, ANON, "https://app.example.com", sender=sender, transport=transport)
        app = create_app(
            mode="cloud",
            store=SupabaseStore(URL, ANON, Sealer(generate_key()), transport=transport),
            auth=SupabaseAuth(URL, ANON, {"*"}, transport=transport),
            billing=Billing(enabled=False),
            welcomer=welcomer,
        )
        return TestClient(app), sent, fake
    return make


def h(token):
    return {"Authorization": "Bearer " + token}


def test_sent_once_to_own_address(app_with):
    client, sent, _ = app_with()
    assert client.post("/api/account/welcome", headers=h("tok-other")).json() == {"sent": True}
    assert client.post("/api/account/welcome", headers=h("tok-other")).json()["sent"] is False
    assert len(sent) == 1
    message, settings = sent[0]
    assert message["To"] == "other@example.com" and settings["password"] == "abcdefghijklmnop"
    assert "Tariq<b>" not in message.get_body(("html",)).get_content()  # name is escaped
    assert client.post("/api/account/welcome").status_code == 401


def test_failed_send_can_retry(app_with):
    client, _, fake = app_with(fail=True)
    assert client.post("/api/account/welcome", headers=h("tok-other")).json()["sent"] is False
    assert not fake.welcomed  # released so the next sign-in tries again


def test_nothing_without_smtp(app_with):
    client, sent, fake = app_with(smtp=False)
    assert client.post("/api/account/welcome", headers=h("tok-other")).json()["reason"] == "email not set up"
    assert not sent and not fake.welcomed


def test_message_reads_well():
    message = build_message("a@b.com", "", "https://x.test", "s@gmail.com")
    assert "Hi there" in message.get_body(("plain",)).get_content()
    assert "https://x.test" in message.get_body(("html",)).get_content()
