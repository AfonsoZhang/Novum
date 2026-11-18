"""MCP stdio server for debate-hub (standard library only).

Exposes 10 tools covering active multi-agent driving (CLI/ACP/MCP/HTTP),
passive open-board participation for any external MCP agent, evidence anchor
verification, and human-in-the-loop adjudication (MCP tools + local HTML card).
"""
from __future__ import annotations

import json
import os
import queue
import sys
import threading
import traceback
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from . import VERSION
from .adapters import make_adapter
from .config import (
    PRESETS,
    ConfigError,
    availability,
    load_config,
    public_agent,
    research_root,
    resolve_agent,
)
from .engine import DebateEngine, DebateError
from .html_card import generate_adjudication_card
from .store import SessionStore, validate_session_id

SERVER_NAME = "debate-hub"
DEFAULT_PROTOCOL = "2025-06-18"
DEBUG_LOG = os.environ.get("DEBATE_HUB_DEBUG_LOG", "")

_stdout_lock = threading.Lock()


def debug_log(message: str) -> None:
    if not DEBUG_LOG:
        return
    try:
        with open(DEBUG_LOG, "a", encoding="utf-8") as fh:
            fh.write(message + "\n")
    except OSError:
        pass


TOOLS: List[Dict[str, Any]] = [
    {
        "name": "debate_agents_list",
        "description": (
            "List configured debate agents, built-in presets detected on this machine "
            "(CLI, ACP, MCP stdio/HTTP, OpenAI-compatible HTTP, and external board), "
            "their model families, read-only guarantees, and availability. "
            "Set probe=true to run safe read-only handshakes (no prompts sent)."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "probe": {"type": "boolean", "description": "Run safe protocol handshakes for enabled agents (default false)."},
                "agentIds": {"type": "array", "items": {"type": "string"}, "description": "Optional subset of configured agent IDs to probe."},
            },
        },
    },
    {
        "name": "debate_create",
        "description": (
            "Create a persisted, evidence-anchored debate session. Presets: "
            "'general' (independent assessment -> debate only on divergence -> judge -> human escalation), "
            "'topic_tournament' (pairwise candidate debates with position-swap + Elo -> human topic decision pack), "
            "'challenge_adjudication' (stable challengeId/claimId adversarial review + cross-family judge). "
            "Primary artifact files are SHA-256 hashed at creation."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "preset": {"type": "string", "enum": ["general", "topic_tournament", "challenge_adjudication"]},
                "title": {"type": "string"},
                "question": {"type": "string", "description": "Research question, claim question, or topic selection objective."},
                "criteria": {"type": "array", "items": {"type": "string"}},
                "artifacts": {"type": "array", "items": {"type": "string"}, "description": "Primary file paths (must stay within allowedRoots)."},
                "cwd": {"type": "string", "description": "Working directory inside allowedRoots."},
                "debaters": {"type": "array", "items": {"type": "string"}, "description": "Configured agent IDs or external board slot IDs."},
                "judges": {"type": "array", "items": {"type": "string"}, "description": "Independent judge agent IDs (must not overlap with debaters)."},
                "sides": {"type": "object", "additionalProperties": {"type": "string"}, "description": "Optional agentId -> stance/side mapping."},
                "executorModel": {"type": "string", "description": "Executor model name for cross-family independence tracking."},
                "executorFamily": {"type": "string", "description": "Explicit executor family name."},
                "requireHumanApproval": {"type": "boolean", "description": "Always force human adjudication (automatically true for topic_tournament)."},
                "challenge": {
                    "type": "object",
                    "description": "Required when preset='challenge_adjudication'.",
                    "properties": {
                        "challengeId": {"type": "string"},
                        "claimId": {"type": "string"},
                        "claimText": {"type": "string"},
                        "challengeDescription": {"type": "string"},
                        "severity": {"type": "string", "enum": ["critical", "major", "minor"]},
                        "defenderRebuttal": {"type": "object", "additionalProperties": True},
                    },
                },
                "candidates": {
                    "type": "array",
                    "description": "Required (>=2 items) when preset='topic_tournament'.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string"},
                            "title": {"type": "string"},
                            "summary": {"type": "string"},
                        },
                        "required": ["title"],
                    },
                },
                "maxCalls": {"type": "integer", "minimum": 1},
                "maxRounds": {"type": "integer", "minimum": 0},
                "maxParallel": {"type": "integer", "minimum": 1},
                "maxMatches": {"type": "integer", "minimum": 1},
                "timeoutSeconds": {"type": "number", "minimum": 1},
                "escalateBelowConfidence": {"type": "number", "minimum": 0, "maximum": 1},
                "swapPositions": {"type": "boolean", "description": "Swap A/B presentation order in topic_tournament (default true)."},
                "sessionId": {"type": "string", "description": "Optional custom session ID."},
            },
            "required": ["question"],
        },
    },
    {
        "name": "debate_run",
        "description": (
            "Run driven agents for an existing debate session. Enforces Phase 1 independent assessment, "
            "triggers bounded rebuttal rounds ONLY on divergence, invokes independent judge(s), verifies "
            "all quotes verbatim against primary files, checks escalation rules, and optionally generates "
            "the local HTML human adjudication card when awaiting_human."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "sessionId": {"type": "string"},
                "forceDebate": {"type": "boolean", "description": "Run rebuttal even if independent verdicts agreed (default false)."},
                "generateCardOnEscalate": {"type": "boolean", "description": "Automatically generate the local HTML card if escalated to human (default true)."},
            },
            "required": ["sessionId"],
        },
    },
    {
        "name": "debate_board_join",
        "description": (
            "Passive board mode: let any external MCP-capable agent register itself on a debate session "
            "as a debater, judge, or observer."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "sessionId": {"type": "string"},
                "agentId": {"type": "string"},
                "role": {"type": "string", "enum": ["debater", "judge", "observer"]},
                "model": {"type": "string"},
                "family": {"type": "string"},
                "side": {"type": "string"},
            },
            "required": ["sessionId", "agentId"],
        },
    },
    {
        "name": "debate_board_read",
        "description": (
            "Read debate session materials and entries. Enforces reviewer independence: while a debater "
            "has not posted its own Phase 1 independent assessment, other debaters' independent posts are hidden."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "sessionId": {"type": "string"},
                "requesterId": {"type": "string", "description": "Participant ID reading the board (enables independence filtering)."},
            },
            "required": ["sessionId"],
        },
    },
    {
        "name": "debate_board_post",
        "description": (
            "Post an independent assessment, rebuttal, or judge ruling to the debate board. "
            "Every quote in `quotes` is verified verbatim against disk files inside allowedRoots."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "sessionId": {"type": "string"},
                "agentId": {"type": "string"},
                "phase": {"type": "string", "enum": ["independent", "rebuttal", "judge"]},
                "round": {"type": "integer", "minimum": 0},
                "verdict": {"type": "string"},
                "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                "summary": {"type": "string"},
                "arguments": {"type": "array", "items": {"type": "string"}},
                "winningArguments": {"type": "array", "items": {"type": "string"}},
                "quotes": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "path": {"type": "string"},
                            "quote": {"type": "string"},
                            "line": {"type": "integer"},
                        },
                        "required": ["path", "quote"],
                    },
                },
                "crux": {"type": "string"},
                "coreCrux": {"type": "string"},
                "decisiveEvidence": {"type": "string"},
                "valueJudgment": {"type": "boolean"},
                "needsHuman": {"type": "boolean"},
                "needsHumanReason": {"type": "string"},
                "model": {"type": "string"},
                "family": {"type": "string"},
                "side": {"type": "string"},
            },
            "required": ["sessionId", "agentId", "phase", "verdict", "summary"],
        },
    },
    {
        "name": "debate_status",
        "description": (
            "Inspect a session's status, independence report, budget usage, artifact staleness, "
            "and decision brief — or list all sessions when sessionId is omitted."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "sessionId": {"type": "string"},
                "statusFilter": {"type": "string", "description": "Optional status filter when listing sessions."},
            },
        },
    },
    {
        "name": "debate_human_pending",
        "description": (
            "List all sessions awaiting explicit human adjudication, with randomized decision briefs, "
            "verified quotes, core crux, escalation reasons, and folded AI recommendation."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "debate_human_card",
        "description": (
            "Generate a local, single-file, offline HTML human adjudication card (human-annotation-page style) "
            "plus frozen .design.json. Randomizes side order, folds AI judge reference by default, displays "
            "verified vs. unverified quote badges, autosaves to localStorage, and downloads a JSON file "
            "compatible with debate_human_submit."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "sessionId": {"type": "string"},
                "outputPath": {"type": "string", "description": "Optional file path inside allowedRoots."},
            },
            "required": ["sessionId"],
        },
    },
    {
        "name": "debate_human_submit",
        "description": (
            "Record an explicit human ruling (inline or imported from a downloaded HTML card JSON file). "
            "Re-checks primary artifact hashes, rejects stale inputs unless allowStale=true, and stores "
            "humanDecision separately from independent AI reviewer verdicts."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "sessionId": {"type": "string"},
                "verdict": {"type": "string"},
                "selectedCandidateId": {"type": "string"},
                "rationale": {"type": "string"},
                "actor": {"type": "string", "description": "Human reviewer identifier (default 'human')."},
                "answersFile": {"type": "string", "description": "Path to downloaded <sessionId>_human_decisions.json."},
                "allowStale": {"type": "boolean", "description": "Explicitly allow recording a decision even if artifacts changed (default false)."},
            },
            "required": ["sessionId"],
        },
    },
]


class DebateHubApp:
    """Testable in-process dispatcher for all MCP tools and resources."""

    def __init__(self, root: Optional[Path] = None,
                 adapter_factory: Optional[Callable[[Dict[str, Any], float], Any]] = None):
        self.root = root or research_root()
        self.adapter_factory = adapter_factory

    def _engine(self) -> tuple[Dict[str, Any], DebateEngine]:
        cfg, _ = load_config(self.root)
        kwargs: Dict[str, Any] = {}
        if self.adapter_factory is not None:
            kwargs["adapter_factory"] = self.adapter_factory
        return cfg, DebateEngine(cfg, **kwargs)

    def call_tool(self, name: str, args: Dict[str, Any],
                  on_progress: Optional[Callable[[str, int, int], None]] = None) -> Dict[str, Any]:
        cfg, engine = self._engine()

        if name == "debate_agents_list":
            do_probe = bool(args.get("probe", False))
            filter_ids = set(args.get("agentIds") or [])
            configured = []
            for aid, spec in cfg["agents"].items():
                row: Dict[str, Any] = {**public_agent(spec), **availability(spec)}
                if do_probe and spec.get("enabled") and row["available"] and spec["kind"] != "external":
                    if not filter_ids or aid in filter_ids:
                        try:
                            adapter = (self.adapter_factory or make_adapter)(spec, 60.0)
                            row["probe"] = adapter.probe()
                        except Exception as exc:
                            row["probe"] = {"handshake": "failed", "error": str(exc)}
                configured.append(row)

            detected = []
            for pname in sorted(PRESETS):
                resolved = resolve_agent(pname, {"preset": pname, "enabled": True}, Path(cfg["root"]))
                av = availability(resolved)
                detected.append({
                    "preset": pname,
                    "kind": resolved["kind"],
                    "familyHint": resolved.get("family"),
                    "readOnly": resolved.get("readOnly"),
                    "available": av["available"],
                    "detail": av["detail"],
                })
            return {
                "configPath": cfg["configPath"],
                "configExists": cfg["configExists"],
                "storeDir": cfg["storeDir"],
                "configuredAgents": configured,
                "detectedPresets": detected,
            }

        if name == "debate_create":
            session = engine.create_session(args)
            return {
                "sessionId": session["sessionId"],
                "preset": session["preset"],
                "status": session["status"],
                "phase": session["phase"],
                "artifacts": session["artifacts"],
                "participants": session["participants"],
                "requireHumanApproval": session["requireHumanApproval"],
                "budget": session["budget"],
            }

        if name == "debate_run":
            sid = str(args.get("sessionId") or "")
            status = engine.run_session(sid, force_debate=bool(args.get("forceDebate", False)),
                                        on_progress=on_progress)
            if status.get("status") == "awaiting_human" and bool(args.get("generateCardOnEscalate", True)):
                s = engine.store.load(sid)
                card = generate_adjudication_card(s, engine.store.cards_dir)
                engine.store.update(sid, lambda rec: rec.__setitem__("card", card))
                status["card"] = card
            return status

        if name == "debate_board_join":
            return engine.board_join(
                str(args.get("sessionId") or ""),
                str(args.get("agentId") or ""),
                role=str(args.get("role") or "debater"),
                model=str(args.get("model") or ""),
                family=str(args.get("family") or ""),
                side=args.get("side"),
            )

        if name == "debate_board_read":
            return engine.board_read(str(args.get("sessionId") or ""), requester_id=args.get("requesterId"))

        if name == "debate_board_post":
            return engine.board_post(str(args.get("sessionId") or ""), args)

        if name == "debate_status":
            sid = args.get("sessionId")
            if sid:
                return engine.get_status(str(sid))
            return {"sessions": engine.store.list_sessions(status_filter=args.get("statusFilter"))}

        if name == "debate_human_pending":
            return {"pending": engine.list_human_pending()}

        if name == "debate_human_card":
            sid = str(args.get("sessionId") or "")
            s = engine.store.load(sid)
            if not s.get("decisionBrief"):
                engine._finalize_outcome(s)
                engine.store.save(s)
            out_path: Optional[Path] = None
            if args.get("outputPath"):
                from .evidence import resolve_allowed_path
                out_path = resolve_allowed_path(str(args["outputPath"]), cfg["allowedRoots"], s["cwd"])
            card = generate_adjudication_card(s, engine.store.cards_dir, output_path=out_path)
            engine.store.update(sid, lambda rec: rec.__setitem__("card", card))
            return {"sessionId": sid, "card": card}

        if name == "debate_human_submit":
            return engine.submit_human_decision(str(args.get("sessionId") or ""), args)

        raise KeyError(f"unknown tool: {name}")

    def list_resources(self) -> List[Dict[str, Any]]:
        cfg, engine = self._engine()
        resources: List[Dict[str, Any]] = [
            {
                "uri": "debate://sessions",
                "name": "All debate sessions",
                "mimeType": "application/json",
                "description": "Index of persisted debate-hub sessions.",
            }
        ]
        for row in engine.store.list_sessions()[:50]:
            sid = row["sessionId"]
            resources.append({
                "uri": f"debate://session/{sid}",
                "name": f"Session {sid}",
                "mimeType": "application/json",
                "description": f"[{row['preset']}] {row['title']} ({row['status']})",
            })
        return resources

    def read_resource(self, uri: str) -> Dict[str, Any]:
        _, engine = self._engine()
        if uri == "debate://sessions":
            data = {"sessions": engine.store.list_sessions()}
            return {"uri": uri, "mimeType": "application/json",
                    "text": json.dumps(data, ensure_ascii=False, indent=2)}
        if uri.startswith("debate://session/"):
            rest = uri[len("debate://session/"):]
            if rest.endswith("/brief"):
                sid = validate_session_id(rest[:-len("/brief")])
                st = engine.get_status(sid)
                return {"uri": uri, "mimeType": "application/json",
                        "text": json.dumps(st.get("decisionBrief") or {}, ensure_ascii=False, indent=2)}
            sid = validate_session_id(rest)
            data = engine.store.load(sid)
            return {"uri": uri, "mimeType": "application/json",
                    "text": json.dumps(data, ensure_ascii=False, indent=2)}
        raise FileNotFoundError(f"unknown resource uri: {uri}")


# ── JSON-RPC stdio loop ──────────────────────────────────────────────────

def _send(msg: Dict[str, Any]) -> None:
    payload = (json.dumps(msg, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    debug_log("SEND " + payload.decode("utf-8", "replace")[:1500])
    with _stdout_lock:
        sys.stdout.buffer.write(payload)
        sys.stdout.buffer.flush()


def _error(rid: Any, code: int, message: str) -> Dict[str, Any]:
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}


def handle_request(app: DebateHubApp, request: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    rid = request.get("id")
    method = request.get("method", "")
    params = request.get("params") or {}
    debug_log(f"REQ id={rid!r} method={method}")

    if rid is None:
        return None  # notifications require no response

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": rid,
            "result": {
                "protocolVersion": params.get("protocolVersion") or DEFAULT_PROTOCOL,
                "capabilities": {"tools": {}, "resources": {}},
                "serverInfo": {"name": SERVER_NAME, "version": VERSION},
            },
        }
    if method == "ping":
        return {"jsonrpc": "2.0", "id": rid, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": rid, "result": {"tools": TOOLS}}
    if method == "resources/list":
        return {"jsonrpc": "2.0", "id": rid, "result": {"resources": app.list_resources()}}
    if method == "resources/read":
        uri = str(params.get("uri") or "")
        try:
            content = app.read_resource(uri)
        except (FileNotFoundError, ValueError) as exc:
            return _error(rid, -32602, str(exc))
        return {"jsonrpc": "2.0", "id": rid, "result": {"contents": [content]}}
    if method == "tools/call":
        tname = str(params.get("name") or "")
        targs = params.get("arguments") or {}
        if not isinstance(targs, dict):
            return _error(rid, -32602, "arguments must be an object")
        token = (params.get("_meta") or {}).get("progressToken")

        def emit_progress(message: str, progress: int, total: int) -> None:
            if token is None:
                return
            _send({
                "jsonrpc": "2.0",
                "method": "notifications/progress",
                "params": {"progressToken": token, "progress": progress, "total": total, "message": message},
            })

        try:
            data = app.call_tool(tname, targs, on_progress=emit_progress)
            text = json.dumps(data, ensure_ascii=False, indent=2)
            return {
                "jsonrpc": "2.0",
                "id": rid,
                "result": {
                    "content": [{"type": "text", "text": text}],
                    "structuredContent": data,
                },
            }
        except KeyError as exc:
            return _error(rid, -32601, str(exc))
        except (DebateError, ConfigError, FileNotFoundError, FileExistsError, ValueError, OSError) as exc:
            err_payload = {"error": str(exc)}
            return {
                "jsonrpc": "2.0",
                "id": rid,
                "result": {
                    "isError": True,
                    "content": [{"type": "text", "text": str(exc)}],
                    "structuredContent": err_payload,
                },
            }
        except Exception:
            debug_log(traceback.format_exc())
            return _error(rid, -32603, "internal error; set DEBATE_HUB_DEBUG_LOG for details")
    return _error(rid, -32601, f"method not found: {method}")


def serve_stdio(app: Optional[DebateHubApp] = None) -> None:
    app = app or DebateHubApp()
    inbox: "queue.Queue[Optional[Dict[str, Any]]]" = queue.Queue()

    def reader() -> None:
        for raw in sys.stdin.buffer:
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if isinstance(msg, dict):
                inbox.put(msg)
        inbox.put(None)

    threading.Thread(target=reader, daemon=True).start()
    debug_log(f"=== {SERVER_NAME} v{VERSION} starting ===")
    while True:
        req = inbox.get()
        if req is None:
            break
        resp = handle_request(app, req)
        if resp is not None:
            _send(resp)
