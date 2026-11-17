"""Cloud mode against a fake Supabase that behaves like PostgREST with row-level security."""

import json
from typing import Any, Dict, List
from urllib.parse import parse_qs

import httpx
import pytest
from fastapi.testclient import TestClient

from app.auth import SupabaseAuth, user_ref
from app.crypto import Sealer, generate_key
from app.main import create_app
from app.stores.supabase import SupabaseStore

URL = "https://fake.supabase.co"
ANON = "anon-public-key"
TOKENS = {
    "tok-me": {"id": "11111111-1111-1111-1111-111111111111", "email": "me@example.com"},
    "tok-other": {"id": "22222222-2222-2222-2222-222222222222", "email": "other@example.com"},
    "tok-stranger": {"id": "33333333-3333-3333-3333-333333333333", "email": "stranger@example.com"},
}
ALLOWED = {"me@example.com", "other@example.com"}

RESUME = """Experience
Loss Prevention Officer, Nov 2024 - Present. Monitored CCTV and wrote incident reports.
Reach me at 201-555-0142 or jordan@example.com.
Control Room Operator, 2019-2023. Dispatched guards and tracked alarms around the clock.
Certifications: CompTIA CySA+, ISC2 CC. Trained on Splunk dashboards and alert triage.
"""


class FakeSupabase:
    """Auth + PostgREST. Rows are visible only to their owner, and only when allowlisted (like RLS)."""

    def __init__(self) -> None:
        self.tables: Dict[str, List[Dict[str, Any]]] = {"ip_sessions": [], "ip_profiles": [], "ip_interviews": []}
        self.requests: List[httpx.Request] = []

    def _user(self, request: httpx.Request):
        assert request.headers["apikey"] == ANON, "every call must carry the anon key, never a service key"
        token = request.headers.get("authorization", "")[7:]
        return TOKENS.get(token)

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        user = self._user(request)
        if request.url.path == "/auth/v1/user":
            return httpx.Response(200, json=user) if user else httpx.Response(401, json={})
        if user is None:
            return httpx.Response(401, json={})
        table = request.url.path.split("/")[-1]
        rows = self.tables[table]
        params = {k: v[0] for k, v in parse_qs(request.url.query.decode()).items()}
        allowed = user["email"] in ALLOWED

        def visible(row: Dict[str, Any]) -> bool:
            if not allowed or row["user_id"] != user["id"]:
                return False
            for key, value in params.items():
                if key in ("select", "order", "limit", "on_conflict"):
                    continue
                if str(row.get(key)) != value.replace("eq.", "", 1):
                    return False
            return True

        if request.method == "GET":
            return httpx.Response(200, json=[dict(row) for row in rows if visible(row)])
        if request.method == "DELETE":
            self.tables[table] = [row for row in rows if not visible(row)]
            return httpx.Response(204)
        if request.method == "POST":
            body = json.loads(request.content)
            if not allowed or body["user_id"] != user["id"]:
                return httpx.Response(403, json={"message": "new row violates row-level security policy"})
            keys = params.get("on_conflict", "").split(",") if "on_conflict" in params else None
            if keys:
                self.tables[table] = rows = [r for r in rows if any(r.get(k) != body.get(k) for k in keys)]
            rows.append(body)
            return httpx.Response(201)
        return httpx.Response(405)


@pytest.fixture()
def cloud():
    fake = FakeSupabase()
    transport = httpx.MockTransport(fake.handler)
    key = generate_key()
    store = SupabaseStore(URL, ANON, Sealer(key), transport=transport)
    auth = SupabaseAuth(URL, ANON, ALLOWED, transport=transport)
    client = TestClient(create_app(mode="cloud", store=store, auth=auth))
    return client, fake, key


def h(token: str) -> Dict[str, str]:
    return {"Authorization": "Bearer " + token}


def upload(client: TestClient, token: str):
    return client.post(
        "/api/sessions",
        data={"role": "GSOC Analyst", "job_description": "Monitor alarms for Example Corp."},
        files={"resume": ("Jordan Sample resume.txt", RESUME.encode(), "text/plain")},
        headers=h(token),
    )


def test_requests_without_an_allowed_sign_in_are_refused(cloud) -> None:
    client, fake, _ = cloud
    assert client.get("/api/interviews").status_code == 401
    assert client.get("/api/interviews", headers=h("forged")).status_code == 401
    assert client.get("/api/interviews", headers=h("tok-stranger")).status_code == 403
    assert upload(client, "tok-stranger").status_code == 403
    assert all(not rows for rows in fake.tables.values())


def test_nothing_readable_is_stored(cloud) -> None:
    client, fake, _ = cloud
    session = upload(client, "tok-me")
    assert session.status_code == 201, session.text
    client.put("/api/profile/notes", json={"notes": "Metro One posts me at H&M."}, headers=h("tok-me"))
    interview = {
        "id": "conv_1",
        "startedAt": "2026-11-17T20:00:00Z",
        "role": "GSOC Analyst",
        "turns": [{"question": "Tell me about an incident.", "answer": "I watched the CCTV at H&M.", "score": None}],
    }
    assert client.put("/api/interviews/conv_1", json=interview, headers=h("tok-me")).status_code == 200

    stored = json.dumps(fake.tables)
    for secret in ("GSOC", "Loss Prevention", "CCTV", "H&M", "Metro One", "Example Corp", "Jordan", "CySA"):
        assert secret not in stored, secret
    assert "555" not in stored and "@example.com" not in stored

    # And it all reads back for its owner.
    assert client.get("/api/profile/notes", headers=h("tok-me")).json()["notes"] == "Metro One posts me at H&M."
    assert client.get("/api/interviews", headers=h("tok-me")).json() == [interview]
    listed = client.get("/api/sessions", headers=h("tok-me")).json()
    assert listed[0]["role"] == "GSOC Analyst" and listed[0]["filename"] == "Jordan Sample resume.txt"


def test_one_user_never_sees_another(cloud) -> None:
    client, _, _ = cloud
    mine = upload(client, "tok-me").json()
    client.put("/api/profile/notes", json={"notes": "mine"}, headers=h("tok-me"))
    client.put("/api/interviews/conv_1", json={"id": "conv_1", "startedAt": "x", "turns": []}, headers=h("tok-me"))

    assert client.get("/api/sessions", headers=h("tok-other")).json() == []
    assert client.get("/api/sessions/" + mine["id"], headers=h("tok-other")).status_code == 404
    assert client.get("/api/profile/notes", headers=h("tok-other")).json()["notes"] == ""
    assert client.get("/api/interviews", headers=h("tok-other")).json() == []
    assert client.delete("/api/sessions/" + mine["id"], headers=h("tok-other")).status_code == 404
    client.delete("/api/account/data", headers=h("tok-other"))
    assert client.get("/api/sessions/" + mine["id"], headers=h("tok-me")).status_code == 200


def test_a_sealed_value_moved_to_another_row_will_not_open(cloud) -> None:
    client, fake, _ = cloud
    first = upload(client, "tok-me").json()
    second = upload(client, "tok-me").json()
    rows = {row["id"]: row for row in fake.tables["ip_sessions"]}
    rows[second["id"]]["chunks_enc"] = rows[first["id"]]["chunks_enc"]  # tampering in the database
    response = client.post(
        "/api/face-to-face/model-answer",
        json={"session_id": second["id"], "role": "GSOC", "question": "Tell me about it.", "answer": "x"},
        headers=h("tok-me"),
    )
    assert response.status_code == 500 and "decrypted" in response.json()["detail"]


def test_search_and_delete_everything(cloud) -> None:
    client, fake, _ = cloud
    session = upload(client, "tok-me").json()
    store = client.app.state.store
    from app.stores.base import User

    me = User(id=TOKENS["tok-me"]["id"], email="me@example.com", access_token="tok-me")
    import asyncio

    top = asyncio.run(store.search(me, session["id"], "certifications CySA+ Splunk", 1))
    assert "CySA+" in top[0]
    assert asyncio.run(store.job_description(me, session["id"])).startswith("Monitor alarms")

    assert client.delete("/api/account/data", headers=h("tok-me")).status_code == 204
    assert all(not rows for rows in fake.tables.values())


def test_me_gives_third_parties_an_opaque_ref(cloud) -> None:
    client, _, _ = cloud
    body = client.get("/api/me", headers=h("tok-me")).json()
    assert body["mode"] == "cloud" and body["ref"].startswith("ip_")
    assert TOKENS["tok-me"]["id"] not in body["ref"] and "me@example.com" not in body["ref"]
    assert body["ref"] == client.get("/api/me", headers=h("tok-me")).json()["ref"]


def test_cloud_hides_api_docs_and_details(cloud) -> None:
    client, _, _ = cloud
    assert client.get("/docs").status_code == 404 and client.get("/openapi.json").status_code == 404
    health = client.get("/api/health").json()
    assert set(health) == {"ok", "mode", "claude_configured"}


def test_user_ref_is_stable_and_one_way() -> None:
    from app.stores.base import User

    assert user_ref(User(id="abc")) == user_ref(User(id="abc")) != user_ref(User(id="abd"))
