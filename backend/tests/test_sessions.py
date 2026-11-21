"""Tests for resume parsing, the local index and the sessions API."""

import importlib
import io
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import resume_store
from app.resume_parser import ResumeError, extract_text
from app.resume_store import ResumeStore, chunk_text, embed
from app.auth import LocalAuth
from app.routers.sessions import build_sessions_router
from app.stores.local import LocalStore

RESUME = """Jane Example
jane@example.com | (201) 555-0142 | https://linkedin.com/in/jane

SUMMARY
Security operations professional with loss prevention and control room experience.

EXPERIENCE
Loss Prevention Officer, Nov 2024 - Present
Monitored 120 CCTV cameras across 3 sites and wrote incident reports for store management.
Coordinated with police on a shoplifting ring and reduced shrink by 18 percent.

Control Room Operator, 2019-2023
Dispatched guards, tracked alarms and kept the access control system running 24/7.

CERTIFICATIONS
CompTIA CySA+, ISC2 CC, AWS Cloud Practitioner. Trained on Splunk dashboards and alert triage.
"""


def minimal_pdf(text: str) -> bytes:
    """A one-page PDF holding `text`, with a correct cross-reference table."""
    stream = "BT /F1 12 Tf 72 720 Td ({}) Tj ET".format(text).encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(out.tell())
        out.write(b"%d 0 obj\n" % number + body + b"\nendobj\n")
    xref = out.tell()
    out.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1))
    for offset in offsets:
        out.write(b"%010d 00000 n \n" % offset)
    out.write(b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref))
    return out.getvalue()


def docx_bytes(paragraphs, table_rows=()) -> bytes:
    from docx import Document

    document = Document()
    for paragraph in paragraphs:
        document.add_paragraph(paragraph)
    if table_rows:
        table = document.add_table(rows=0, cols=len(table_rows[0]))
        for row in table_rows:
            cells = table.add_row().cells
            for cell, value in zip(cells, row):
                cell.text = value
    buffer = io.BytesIO()
    document.save(buffer)
    return buffer.getvalue()


# --- parsing -------------------------------------------------------------------


def test_reads_txt_pdf_and_docx() -> None:
    assert "Loss Prevention Officer" in extract_text("resume.txt", RESUME.encode())
    assert "Monitored CCTV cameras" in extract_text("cv.PDF", minimal_pdf("Monitored CCTV cameras at three sites"))
    text = extract_text("cv.docx", docx_bytes(["Control Room Operator"], [("Skills", "Splunk"), ("Certs", "CySA+")]))
    assert "Control Room Operator" in text and "Skills | Splunk" in text and "CySA+" in text


@pytest.mark.parametrize(
    "name,data,expected",
    [
        ("resume.pages", b"x", "PDF, DOCX, TXT or MD"),
        ("resume.txt", b"", "empty"),
        ("resume.pdf", b"not a pdf at all", "valid PDF"),
        ("resume.docx", b"not a docx", "valid DOCX"),
        ("resume.txt", b"x" * (4 * 1024 * 1024 + 1), "4 MB"),
    ],
)
def test_bad_uploads_explain_themselves(name, data, expected) -> None:
    with pytest.raises(ResumeError) as caught:
        extract_text(name, data)
    assert expected in str(caught.value)


# --- chunking and vectors ------------------------------------------------------


def test_chunks_are_bounded_and_cover_the_text() -> None:
    text = "\n".join("Line {} about monitoring alarms and writing incident reports.".format(i) for i in range(60))
    chunks = chunk_text(text, size=300, overlap=60)
    assert len(chunks) > 5
    assert all(len(chunk) <= 300 for chunk in chunks)
    joined = " ".join(chunks)
    assert all("Line {} ".format(i) in joined for i in range(60))


def test_a_long_single_line_is_windowed() -> None:
    chunks = chunk_text("word " * 600, size=400, overlap=50)
    assert len(chunks) > 5 and all(len(chunk) <= 400 for chunk in chunks)


def test_vectors_are_unit_length_and_stable() -> None:
    import numpy as np

    vectors = embed(["Splunk alert triage", "Splunk alert triage", ""])
    assert np.allclose(np.linalg.norm(vectors[0]), 1.0)
    assert np.array_equal(vectors[0], vectors[1])
    assert not vectors[2].any()


# --- the store -----------------------------------------------------------------


@pytest.fixture(params=["faiss", "numpy"])
def engine(request, monkeypatch):
    if request.param == "numpy":
        monkeypatch.setattr(resume_store, "faiss", None)
    elif resume_store.faiss is None:
        pytest.skip("faiss is not installed")
    return request.param


def test_search_puts_the_relevant_passage_first(engine, tmp_path) -> None:
    store = ResumeStore(tmp_path)
    assert store.engine == engine
    session = store.create("GSOC Analyst", "", "resume.txt", RESUME)
    top = store.search(session.id, "Which certifications and Splunk training do you have?", 2)
    assert "CySA+" in top[0]
    top = store.search(session.id, "Tell me about the shoplifting ring and police", 1)
    assert "shoplifting" in top[0]
    assert len(store.search(session.id, "anything", 50)) == len(session.chunks)
    assert store.search("0" * 32, "anything", 3) == []


def test_sessions_survive_a_restart_and_delete_removes_files(engine, tmp_path) -> None:
    store = ResumeStore(tmp_path)
    session = store.create("GSOC Analyst", "Monitor alarms.", "resume.txt", RESUME)
    assert json.loads((tmp_path / session.id / "meta.json").read_text())["role"] == "GSOC Analyst"

    (tmp_path / "not-a-session").mkdir()  # ignored
    (tmp_path / ("f" * 32)).mkdir()  # damaged: no files, skipped
    reopened = ResumeStore(tmp_path)
    assert reopened.load_all() == 1
    loaded = reopened.get(session.id)
    assert loaded is not None and loaded.job_description == "Monitor alarms."
    assert "CySA+" in reopened.search(session.id, "certifications CySA+", 1)[0]

    assert reopened.delete(session.id) is True
    assert not (tmp_path / session.id).exists()
    assert reopened.delete(session.id) is False
    assert reopened.delete("../../etc") is False


def test_memory_only_store_writes_nothing(tmp_path) -> None:
    store = ResumeStore(None)
    session = store.create("Role", "", "r.txt", RESUME)
    assert store.get(session.id) is not None and list(tmp_path.iterdir()) == []


# --- the API -------------------------------------------------------------------


@pytest.fixture()
def api(tmp_path):
    store = LocalStore(tmp_path)
    app = FastAPI()
    app.include_router(build_sessions_router(store, LocalAuth()))
    return TestClient(app), store.resumes


def test_upload_creates_a_session_without_contact_details(api) -> None:
    client, store = api
    response = client.post(
        "/api/sessions",
        data={"role": "  GSOC   Analyst ", "job_description": "Monitor alarms. Apply: hr@example.com"},
        files={"resume": ("resume.txt", RESUME.encode(), "text/plain")},
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["role"] == "GSOC Analyst" and body["passage_count"] >= 1 and body["has_job_description"] is True
    session = store.get(body["id"])
    stored = " ".join(session.chunks) + session.job_description
    assert "@" not in stored and "555" not in stored and "linkedin" not in stored
    assert "Nov 2024" in stored and "2019-2023" in stored and "120 CCTV" in stored

    assert client.get("/api/sessions/" + body["id"]).json()["filename"] == "resume.txt"
    assert [item["id"] for item in client.get("/api/sessions").json()] == [body["id"]]
    assert client.delete("/api/sessions/" + body["id"]).status_code == 204
    assert client.get("/api/sessions/" + body["id"]).status_code == 404
    assert client.delete("/api/sessions/" + body["id"]).status_code == 404


@pytest.mark.parametrize(
    "role,name,data,expected",
    [
        ("x", "resume.txt", RESUME.encode(), "role"),
        ("Analyst", "resume.txt", b"too short", "enough text"),
        ("Analyst", "resume.png", b"\x89PNG", "PDF, DOCX"),
    ],
)
def test_upload_problems_are_422_with_a_reason(api, role, name, data, expected) -> None:
    client, _ = api
    response = client.post("/api/sessions", data={"role": role}, files={"resume": (name, data, "application/octet-stream")})
    assert response.status_code == 422
    assert expected in response.json()["detail"]


# --- the whole app -------------------------------------------------------------


def test_app_boots_and_reports_health(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("INTERVIEWPILOT_DATA_DIR", str(tmp_path))
    # Keep the test away from a real backend/.env on this machine.
    monkeypatch.setenv("INTERVIEWPILOT_ENV_FILE", str(tmp_path / "missing.env"))
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("F2F_MODEL", raising=False)
    monkeypatch.delenv("INTERVIEWPILOT_MODE", raising=False)
    import app.main as main

    main = importlib.reload(main)
    client = TestClient(main.app)

    health = client.get("/api/health").json()
    assert health["ok"] is True and health["mode"] == "local"
    assert health["claude_configured"] is False and health["model"] == "claude-sonnet-5-5"

    created = client.post("/api/sessions", data={"role": "GSOC Analyst"}, files={"resume": ("r.txt", RESUME.encode(), "text/plain")})
    assert created.status_code == 201
    assert (tmp_path / "sessions" / created.json()["id"]).is_dir()
    plan = client.post("/api/face-to-face/plan", json={"session_id": created.json()["id"], "role": "GSOC Analyst"})
    assert plan.status_code == 503 and "ANTHROPIC_API_KEY" in plan.json()["detail"]

    # Notes and interview history persist to disk.
    assert client.put("/api/profile/notes", json={"notes": "Posted at H&M. Reach me at jane@example.com"}).json() == {
        "notes": "Posted at H&M. Reach me at [email removed]"
    }
    interview = {"id": "conv_1", "startedAt": "2026-11-17T20:00:00Z", "turns": [], "average": None}
    assert client.put("/api/interviews/conv_1", json=interview).status_code == 200
    assert client.put("/api/interviews/other", json=interview).status_code == 422
    reopened = TestClient(importlib.reload(main).app)
    assert reopened.get("/api/profile/notes").json()["notes"].startswith("Posted at H&M")
    assert [item["id"] for item in reopened.get("/api/interviews").json()] == ["conv_1"]
    me = reopened.get("/api/me").json()
    assert me["mode"] == "local" and me["ref"].startswith("ip_") and me["email"] is None

    assert reopened.delete("/api/account/data").status_code == 204
    assert reopened.get("/api/interviews").json() == [] and reopened.get("/api/sessions").json() == []
    assert reopened.get("/api/profile/notes").json()["notes"] == ""

    # A key pasted into backend/.env after start-up is picked up without a restart.
    env_file = tmp_path / "pasted.env"
    env_file.write_text("ANTHROPIC_API_KEY=sk-test\nF2F_MODEL=\n")
    monkeypatch.setattr(main, "ENV_FILE", env_file)
    assert reopened.get("/api/health").json()["claude_configured"] is True
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)  # set by the app, not by monkeypatch

    # Only this machine's pages pass CORS.
    ok = reopened.options("/api/health", headers={"Origin": "http://localhost:3001", "Access-Control-Request-Method": "GET"})
    assert ok.headers.get("access-control-allow-origin") == "http://localhost:3001"
    blocked = reopened.options("/api/health", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"})
    assert "access-control-allow-origin" not in blocked.headers


def test_cloud_mode_without_settings_refuses_everything(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("INTERVIEWPILOT_ENV_FILE", str(tmp_path / "missing.env"))
    for name in ("SUPABASE_URL", "SUPABASE_ANON_KEY", "DATA_ENCRYPTION_KEY", "ALLOWED_EMAILS"):
        monkeypatch.delenv(name, raising=False)
    from app.main import create_app

    client = TestClient(create_app(mode="cloud"))
    for method, path in (("get", "/api/health"), ("get", "/api/interviews"), ("post", "/api/sessions")):
        response = getattr(client, method)(path)
        assert response.status_code == 503 and "SUPABASE_URL" in response.json()["detail"]


def test_a_phone_file_without_an_extension_is_recognised() -> None:
    from app.resume_parser import extract_text
    pdf_like = extract_text("Tariq Resume", b"Telecom engineer, fiber and RF planning, 6 years across West Africa.")
    assert "Telecom engineer" in pdf_like
