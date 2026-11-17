"""Tests for the face-to-face router, with a fake Claude client and a fake index."""

from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers.face_to_face import build_face_to_face_router, scrub_contact_details

RESUME = [
    "Loss Prevention Officer, since Nov 2024. Monitored CCTV and wrote incident reports.",
    "CompTIA CySA+. Splunk. Contact: 201-555-0142, jane@example.com",
]


class FakeMessages:
    def __init__(self, replies) -> None:
        self.replies = replies
        self.calls = []

    async def create(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return SimpleNamespace(
            content=[SimpleNamespace(type="tool_use", name=kwargs["tools"][0]["name"], input=reply)]
        )


def make(replies, chunks=None, job_description="", notes=""):
    messages = FakeMessages(replies)
    retrieved = []

    async def retrieve(user, session_id: str, query: str, k: int):
        retrieved.append((session_id, query, k))
        return RESUME if chunks is None else chunks

    app = FastAPI()
    async def job_context(user, session_id: str) -> str:
        return job_description

    async def notes_source(user) -> str:
        return notes

    app.include_router(
        build_face_to_face_router(
            retrieve, client=SimpleNamespace(messages=messages), model="test-model", job_context=job_context,
            notes=notes_source,
        )
    )
    return TestClient(app), messages, retrieved


def test_scrub_removes_contacts_and_keeps_dates() -> None:
    out = scrub_contact_details("Call (201) 555-0142 or +233 24 123 4567, mail a@b.co, see https://x.dev, 2019-2024")
    assert "555" not in out and "@" not in out and "x.dev" not in out and "4567" not in out
    assert "2019-2024" in out


def test_plan_grounds_on_resume_and_scrubs_output() -> None:
    client, messages, retrieved = make(
        [
            {
                "candidate_brief": "Loss prevention officer with CySA+. Phone 201-555-0142.",
                "questions": [
                    {"text": "Tell me about an incident report you wrote.", "category": "behavioral"},
                    {"text": "How have you used Splunk?", "category": "technical"},
                    {"text": "Extra question beyond the count.", "category": "experience"},
                ],
            }
        ]
    )
    response = client.post("/api/face-to-face/plan", json={"session_id": "s1", "role": "GSOC Analyst", "question_count": 2})
    assert response.status_code == 200, response.text
    body = response.json()
    assert [q["id"] for q in body["questions"]] == ["q1", "q2"]
    assert "555" not in body["candidate_brief"]
    assert retrieved[0][0] == "s1"
    call = messages.calls[0]
    assert call["model"] == "test-model"
    assert call["tool_choice"] == {"type": "tool", "name": "submit_plan"}
    assert "Monitored CCTV" in call["messages"][0]["content"]
    assert "Never invent" in call["system"]


def test_plan_needs_a_resume() -> None:
    client, messages, _ = make([], chunks=[])
    response = client.post("/api/face-to-face/plan", json={"session_id": "s1", "role": "GSOC Analyst"})
    assert response.status_code == 409
    assert messages.calls == []


def test_score_returns_structured_feedback() -> None:
    client, messages, _ = make(
        [
            {
                "is_answer": True,
                "score": 14,
                "strengths": ["You named the tool you used."],
                "improvements": ["Say what the result was."],
                "not_in_resume": ["Led a team of 12"],
                "follow_up": "What was the outcome?",
            }
        ]
    )
    response = client.post(
        "/api/face-to-face/score",
        json={"session_id": "s1", "role": "GSOC Analyst", "question": "How have you used Splunk?", "answer": "I led a team of 12 and built dashboards."},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["score"] == 10  # clamped
    assert body["follow_up"] == "What was the outcome?"
    assert body["not_in_resume"] == ["Led a team of 12"]
    assert "<answer>" in messages.calls[0]["messages"][0]["content"]


def test_score_drops_follow_up_when_not_allowed() -> None:
    client, _, _ = make([{"is_answer": True, "score": 6, "strengths": [], "improvements": [], "not_in_resume": [], "follow_up": "And then?"}])
    response = client.post(
        "/api/face-to-face/score",
        json={"session_id": "s1", "role": "GSOC Analyst", "question": "How do you triage?", "answer": "By severity.", "allow_follow_up": False},
    )
    assert response.json()["follow_up"] is None


def test_clarification_is_not_an_answer() -> None:
    client, _, _ = make([{"is_answer": False, "score": 0, "strengths": [], "improvements": [], "not_in_resume": [], "follow_up": None}])
    response = client.post(
        "/api/face-to-face/score",
        json={"session_id": "s1", "role": "GSOC Analyst", "question": "How do you triage?", "answer": "Sorry, can you repeat that?"},
    )
    assert response.json()["is_answer"] is False


def test_claude_failure_is_a_502_without_leaking_details() -> None:
    client, _, _ = make([RuntimeError("secret key sk-123 rejected")])
    response = client.post(
        "/api/face-to-face/score",
        json={"session_id": "s1", "role": "GSOC Analyst", "question": "How do you triage?", "answer": "By severity."},
    )
    assert response.status_code == 502
    assert "sk-123" not in response.text


@pytest.mark.parametrize("payload", [{"session_id": "", "role": "x"}, {"session_id": "s", "role": "GSOC", "question_count": 50}])
def test_plan_validates_input(payload) -> None:
    client, _, _ = make([])
    assert client.post("/api/face-to-face/plan", json=payload).status_code == 422


class BadRequestError(Exception):
    """Stands in for anthropic.BadRequestError: the router matches on the class name."""


def test_falls_back_when_the_model_refuses_a_forced_tool_call() -> None:
    reply = {"is_answer": True, "score": 5, "strengths": [], "improvements": [], "not_in_resume": [], "follow_up": None}
    client, messages, _ = make([BadRequestError("thinking + forced tool"), reply])
    response = client.post(
        "/api/face-to-face/score",
        json={"session_id": "s1", "role": "GSOC Analyst", "question": "How do you triage?", "answer": "By severity."},
    )
    assert response.status_code == 200, response.text
    assert messages.calls[0]["tool_choice"] == {"type": "tool", "name": "submit_score"}
    assert messages.calls[1]["tool_choice"] == {"type": "auto"}
    assert "submit_score tool" in messages.calls[1]["messages"][0]["content"]


def test_plan_includes_the_job_description_and_avoids_company_names() -> None:
    plan = {"candidate_brief": "Officer.", "questions": [{"text": "Why this role?", "category": "motivation"}]}
    client, messages, _ = make([plan], job_description="GSOC Analyst at Example Corp. Monitor alarms.")
    response = client.post("/api/face-to-face/plan", json={"session_id": "s1", "role": "GSOC Analyst", "question_count": 1})
    assert response.status_code == 200, response.text
    assert "<job_description>" in messages.calls[0]["messages"][0]["content"]
    assert "Do not mention any company by name" in messages.calls[0]["system"]


def test_missing_key_is_a_503_that_says_what_to_do(monkeypatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    async def retrieve(user, session_id: str, query: str, k: int):
        return RESUME

    app = FastAPI()
    app.include_router(build_face_to_face_router(retrieve))
    response = TestClient(app).post("/api/face-to-face/plan", json={"session_id": "s1", "role": "GSOC Analyst"})
    assert response.status_code == 503
    assert "backend/.env" in response.json()["detail"]


def test_notes_reach_claude_scrubbed_and_count_as_evidence() -> None:
    reply = {"is_answer": True, "score": 6, "strengths": [], "improvements": [], "not_in_resume": [], "follow_up": None}
    client, messages, _ = make([reply], notes="Metro One posts me at H&M in Manhattan. Call 201-555-0142.")
    client.post(
        "/api/face-to-face/score",
        json={"session_id": "s1", "role": "LP Officer", "question": "Where do you work?", "answer": "At H&M."},
    )
    sent = messages.calls[0]["messages"][0]["content"]
    assert "<candidate_notes>" in sent and "Metro One posts me at H&M" in sent
    assert "555" not in sent
    assert "count as evidence" in messages.calls[0]["system"]


def test_model_answer_is_grounded_and_scrubbed() -> None:
    reply = {
        "model_answer": "At my post I noticed a man conceal a jacket. [say what was recovered] Call me at 201-555-0142.",
        "what_changed": ["You lead with the situation.", "You end on the outcome."],
    }
    client, messages, retrieved = make([reply], notes="Posted at H&M by Metro One.")
    response = client.post(
        "/api/face-to-face/model-answer",
        json={"session_id": "s1", "role": "LP Officer", "question": "Tell me about an incident.", "answer": "Um I saw a guy."},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert "[say what was recovered]" in body["model_answer"] and "555" not in body["model_answer"]
    assert body["what_changed"] == ["You lead with the situation.", "You end on the outcome."]
    assert retrieved and messages.calls[0]["tool_choice"]["name"] == "submit_model_answer"
    assert "Do not add facts" in messages.calls[0]["system"]


def test_model_answer_without_a_session_skips_the_resume() -> None:
    reply = {"model_answer": "A stronger answer.", "what_changed": []}
    client, messages, retrieved = make([reply])
    response = client.post(
        "/api/face-to-face/model-answer",
        json={"role": "LP Officer", "question": "Tell me about an incident.", "answer": "I saw a guy."},
    )
    assert response.status_code == 200 and retrieved == []
    assert "(none available)" in messages.calls[0]["messages"][0]["content"]
