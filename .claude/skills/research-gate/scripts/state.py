"""Atomic disk state, source snapshots, retrieval ledger, and staleness tracking."""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import uuid

from models import GATE_STAGES

GATE_DIR = ".research-gate"
GATE_STATE_FILE = ".research-gate/state.json"
GATE_EVENTS_FILE = ".research-gate/events.jsonl"
GATE_RETRIEVALS_FILE = ".research-gate/retrievals.jsonl"
SOURCE_ID_RE = re.compile(r"^SRC-[A-Za-z0-9_-]+$")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def safe_local(root: Path, rel: str) -> Path:
    root_real = root.resolve()
    target = (root_real / rel).resolve()
    try:
        target.relative_to(root_real)
    except ValueError as exc:
        raise ValueError(f"Path outside project workspace: {rel}") from exc
    return target


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return f"sha256:{h.hexdigest()}"


def atomic_write_json(file_path: Path, data: dict) -> None:
    file_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = file_path.with_name(f"{file_path.name}.{uuid.uuid4().hex}.tmp")
    text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(fd, text.encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(tmp, file_path)


def stage_index(stage: str) -> int:
    return GATE_STAGES.index(stage)


def resolve_artifact_hashes(root: Path, files: list[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for rel in files:
        target = safe_local(root, rel)
        if target.is_file():
            result[rel] = sha256_file(target)
    return result


class GateStore:
    def __init__(self, root: str | Path) -> None:
        self.root = Path(root).resolve()
        self.dir = self.root / GATE_DIR
        self.file = self.root / GATE_STATE_FILE
        self.events_file = self.root / GATE_EVENTS_FILE
        self.retrievals_file = self.root / GATE_RETRIEVALS_FILE
        self.sources_dir = self.dir / "sources"

    @contextmanager
    def command_lock(self, initializing: bool = False):
        if initializing:
            self.dir.mkdir(parents=True, exist_ok=True)
        elif not self.exists():
            raise FileNotFoundError(f"Gate workspace not initialized at {self.file}")
        # Keep one stable lock inode across atomic replacements of state.json.
        # Closing the handle also releases the OS lock if a CLI process exits.
        with (self.dir / "command.lock").open("a+b") as lock:
            if os.name == "nt":
                import msvcrt
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
            else:
                import fcntl
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            yield

    def exists(self) -> bool:
        return self.file.is_file()

    def read(self) -> dict:
        if not self.exists():
            raise FileNotFoundError(f"Gate workspace not initialized at {self.file}")
        state = json.loads(self.file.read_text(encoding="utf-8"))
        if state.get("version", 1) == 1:
            # Workspaces that have never passed planning have no frozen file set.
            stages = state.get("stages", {})
            has_plan = stages.get("plan", {}).get("passed") or "plan" in state.get("approvals", {})
            downstream = any(stage in stages for stage in GATE_STAGES[stage_index("experiment"):])
            if not has_plan and not downstream and not state.get("reworks", {}).get("history"):
                state["version"] = 2
        return state

    def write(self, state: dict) -> dict:
        state["updatedAt"] = utc_now()
        atomic_write_json(self.file, state)
        return state

    def append_event(self, event_type: str, data: dict | None = None) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        entry = {"time": utc_now(), "type": event_type, "data": data or {}}
        with self.events_file.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def append_retrieval(self, record: dict) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        with self.retrievals_file.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")

    def read_retrievals(self) -> list[dict]:
        if not self.retrievals_file.is_file():
            return []
        records: list[dict] = []
        for line in self.retrievals_file.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if stripped:
                records.append(json.loads(stripped))
        return records

    def save_source_snapshot(
        self,
        source_id: str,
        title: str,
        identity: str,
        *,
        file_path: str | None = None,
        content: str | None = None,
        citation_keys: list[str] | None = None,
    ) -> dict:
        if not SOURCE_ID_RE.match(source_id):
            raise ValueError("Source ID must match ^SRC-[A-Za-z0-9_-]+$")
        self.sources_dir.mkdir(parents=True, exist_ok=True)
        if content is not None:
            rel = f"{GATE_DIR}/sources/{source_id}.txt"
            abs_path = safe_local(self.root, rel)
            abs_path.write_text(content, encoding="utf-8")
        elif file_path:
            abs_path = safe_local(self.root, file_path)
            if not abs_path.is_file():
                raise FileNotFoundError(f"Source file does not exist: {file_path}")
            rel = abs_path.relative_to(self.root).as_posix()
        else:
            raise ValueError("Either content or file_path is required when registering a source")

        return {
            "id": source_id,
            "title": title.strip(),
            "identity": identity.strip(),
            "path": rel,
            "sha256": sha256_file(safe_local(self.root, rel)),
            "retrievedAt": utc_now(),
            "citationKeys": citation_keys or [],
        }
