"""Atomic, file-locked persistence for debate-hub sessions."""
from __future__ import annotations

import contextlib
import fcntl
import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional

SESSION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$")


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def new_session_id(prefix: str = "deb") -> str:
    safe = re.sub(r"[^A-Za-z0-9_-]", "", prefix)[:16] or "deb"
    return f"{safe}-{time.strftime('%Y%m%d-%H%M%S', time.gmtime())}-{uuid.uuid4().hex[:6]}"


def validate_session_id(session_id: str) -> str:
    if not isinstance(session_id, str) or not SESSION_ID_RE.match(session_id):
        raise ValueError(f"invalid sessionId: {session_id!r}")
    return session_id


class SessionStore:
    def __init__(self, store_dir: str):
        self.root = Path(store_dir).resolve()
        self.sessions_dir = self.root / "sessions"
        self.cards_dir = self.root / "cards"
        self.locks_dir = self.root / ".locks"
        self.sessions_dir.mkdir(parents=True, exist_ok=True)
        self.cards_dir.mkdir(parents=True, exist_ok=True)
        self.locks_dir.mkdir(parents=True, exist_ok=True)

    def session_path(self, session_id: str) -> Path:
        validate_session_id(session_id)
        return self.sessions_dir / f"{session_id}.json"

    @contextlib.contextmanager
    def lock(self, session_id: str) -> Iterator[None]:
        validate_session_id(session_id)
        lock_file = self.locks_dir / f"{session_id}.lock"
        with lock_file.open("a+") as fh:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)

    def _write_atomic(self, path: Path, payload: Dict[str, Any]) -> None:
        tmp = path.with_suffix(f".{os.getpid()}.{uuid.uuid4().hex[:6]}.tmp")
        data = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
        tmp.write_text(data, encoding="utf-8")
        os.replace(tmp, path)

    def create(self, session: Dict[str, Any]) -> Dict[str, Any]:
        sid = validate_session_id(session["sessionId"])
        path = self.session_path(sid)
        with self.lock(sid):
            if path.exists():
                raise FileExistsError(f"session already exists: {sid}")
            self._write_atomic(path, session)
            return session

    def load(self, session_id: str) -> Dict[str, Any]:
        path = self.session_path(session_id)
        if not path.is_file():
            raise FileNotFoundError(f"session not found: {session_id}")
        return json.loads(path.read_text(encoding="utf-8"))

    def save(self, session: Dict[str, Any]) -> Dict[str, Any]:
        sid = validate_session_id(session["sessionId"])
        session["updatedAt"] = utc_now()
        with self.lock(sid):
            self._write_atomic(self.session_path(sid), session)
            return session

    def update(self, session_id: str, mutator: Callable[[Dict[str, Any]], Any]) -> Any:
        sid = validate_session_id(session_id)
        path = self.session_path(sid)
        with self.lock(sid):
            if not path.is_file():
                raise FileNotFoundError(f"session not found: {sid}")
            session = json.loads(path.read_text(encoding="utf-8"))
            result = mutator(session)
            session["updatedAt"] = utc_now()
            self._write_atomic(path, session)
            return result

    def list_sessions(self, status_filter: Optional[str] = None) -> List[Dict[str, Any]]:
        rows: List[Dict[str, Any]] = []
        for path in sorted(self.sessions_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if status_filter and data.get("status") != status_filter:
                continue
            rows.append({
                "sessionId": data.get("sessionId"),
                "preset": data.get("preset"),
                "title": data.get("title"),
                "status": data.get("status"),
                "phase": data.get("phase"),
                "createdAt": data.get("createdAt"),
                "updatedAt": data.get("updatedAt"),
                "awaitingHuman": data.get("status") == "awaiting_human",
                "humanDecisionRecorded": bool(data.get("humanDecision")),
                "callsUsed": (data.get("budget") or {}).get("callsUsed", 0),
                "maxCalls": (data.get("budget") or {}).get("maxCalls", 0),
            })
        return rows
