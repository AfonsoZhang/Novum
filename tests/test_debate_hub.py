"""Comprehensive tests for the optional debate-hub MCP plugin.

Covers:
  * All 4 active adapters (CLI, ACP, MCP stdio & streamable-HTTP/SSE, OpenAI-compat HTTP)
  * Passive open-board participation & Phase 1 anti-contamination filter
  * Evidence anchoring (exact/whitespace/missing quotes, path confinement, SHA-256 staleness)
  * All 3 presets (general, topic_tournament with position-swap Elo, challenge_adjudication)
  * Budget caps, no automatic retries on timeout/failure, cross-family independence tracking
  * Local HTML adjudication card generation (JS syntax check, blind default, JSON round-trip import)
  * Live MCP stdio JSON-RPC server handshake & tool dispatch
  * Opt-in setup script idempotency (enable_debate_hub.py)
"""
from __future__ import annotations

import http.server
import json
import os
import re
import socketserver
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from typing import Any, Dict, List

ROOT = Path(__file__).resolve().parents[1]
HUB_DIR = ROOT / ".agents" / "mcp-servers" / "debate-hub"
sys.path.insert(0, str(HUB_DIR))
sys.path.insert(0, str(ROOT / "scripts"))

from debatehub.adapters import AcpAdapter, CallResult, CliAdapter, HttpAdapter, McpAdapter  # noqa: E402
from debatehub.config import load_config, resolve_agent  # noqa: E402
from debatehub.evidence import check_artifact_staleness, snapshot_artifacts, verify_quote  # noqa: E402
from debatehub.jsonrpc import StdioPeer  # noqa: E402
from debatehub.server import DebateHubApp  # noqa: E402
import enable_debate_hub  # noqa: E402


FAKE_ACP_SCRIPT = r'''#!/usr/bin/env python3
import json, os, sys

mode_supported = os.environ.get("FAKE_ACP_PLAN", "1") == "1"
permission_denied = None

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

for raw in sys.stdin:
    line = raw.strip()
    if not line:
        continue
    msg = json.loads(line)
    mid = msg.get("id")
    method = msg.get("method")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": 1, "agentInfo": {"name": "fake-acp"}}})
    elif method == "session/new":
        modes = [{"id": "default"}, {"id": "plan"}] if mode_supported else [{"id": "default"}]
        send({"jsonrpc": "2.0", "id": mid, "result": {
            "sessionId": "acp-sess-1",
            "modes": {"availableModes": modes, "currentModeId": "default"},
            "models": {"availableModels": [{"modelId": "gemini-3.1-pro"}], "currentModelId": "gemini-3.1-pro"},
        }})
    elif method == "session/set_mode":
        send({"jsonrpc": "2.0", "id": mid, "result": {}})
    elif method == "session/prompt":
        # Try to ask permission for a destructive tool; hub must reject it!
        send({"jsonrpc": "2.0", "id": 999, "method": "session/request_permission", "params": {
            "toolCall": {"title": "rm -rf /"},
            "options": [{"optionId": "allow_once", "kind": "allow_once"},
                        {"optionId": "reject_once", "kind": "reject_once"}],
        }})
        reply_raw = sys.stdin.readline()
        reply = json.loads(reply_raw)
        outcome = reply.get("result", {}).get("outcome", {})
        permission_denied = (outcome.get("optionId") == "reject_once")
        payload = json.dumps({
            "verdict": "SUPPORT" if permission_denied else "FAIL",
            "confidence": 0.9,
            "summary": "ACP response with permission rejected=" + str(permission_denied),
            "arguments": ["Checked file"],
            "quotes": [],
        })
        send({"jsonrpc": "2.0", "method": "session/update", "params": {
            "sessionId": "acp-sess-1",
            "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": payload}},
        }})
        send({"jsonrpc": "2.0", "id": mid, "result": {"stopReason": "end_turn"}})
'''

FAKE_MCP_STDIO_SCRIPT = r'''#!/usr/bin/env python3
import json, sys

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

for raw in sys.stdin:
    line = raw.strip()
    if not line:
        continue
    msg = json.loads(line)
    mid = msg.get("id")
    method = msg.get("method")
    if mid is None:
        continue
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": "2025-06-18",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "fake-agent-mcp", "version": "1.0"},
        }})
    elif method == "tools/list":
        send({"jsonrpc": "2.0", "id": mid, "result": {"tools": [{"name": "ask_agent", "inputSchema": {"type": "object"}}]}})
    elif method == "tools/call":
        args = msg["params"]["arguments"]
        body = json.dumps({"verdict": "PASS", "confidence": 0.85, "summary": "MCP stdio ok: " + args.get("prompt", "")[:30]})
        send({"jsonrpc": "2.0", "id": mid, "result": {
            "content": [{"type": "text", "text": body}],
            "structuredContent": {"answer": body, "reviewer_models": ["gpt-5.4"]},
        }})
'''

FAKE_CLI_SCRIPT = r'''#!/usr/bin/env python3
import json, os, sys, time

if os.environ.get("FAKE_CLI_SLEEP"):
    time.sleep(float(os.environ["FAKE_CLI_SLEEP"]))
if os.environ.get("FAKE_CLI_FAIL"):
    sys.stderr.write("SECRET_API_KEY=sk-should-never-leak\n")
    sys.exit(2)

log = os.environ.get("FAKE_CLI_LOG")
if log:
    with open(log, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(sys.argv[1:]) + "\n")

stdin_text = sys.stdin.read() if not sys.stdin.isatty() else ""
out_flag = None
if "--output-last-message" in sys.argv:
    out_flag = sys.argv[sys.argv.index("--output-last-message") + 1]

payload = json.dumps({"verdict": "PASS", "confidence": 0.88, "summary": "CLI ok", "quotes": []})
if out_flag:
    with open(out_flag, "w", encoding="utf-8") as fh:
        fh.write(payload)
else:
    print(json.dumps({"result": payload, "is_error": False, "modelUsage": {"claude-opus-5": {}}}))
'''


class _FakeAdapter:
    """In-process programmable adapter for deterministic engine tests."""

    def __init__(self, agent: Dict[str, Any], handler):
        self.agent = agent
        self.handler = handler
        self.needs_inline_materials = bool(agent.get("inlineMaterials", False))

    def ask(self, prompt: str, cwd: str) -> CallResult:
        return self.handler(self.agent, prompt, cwd)

    def probe(self) -> Dict[str, Any]:
        return {"handshake": "ok"}


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def _write_exec(self, name: str, content: str) -> Path:
        p = self.root / name
        p.write_text(content, encoding="utf-8")
        p.chmod(p.stat().st_mode | stat.S_IEXEC)
        return p

    def test_cli_model_arg_positions_and_no_stderr_leak(self):
        cli = self._write_exec("fake_cli.py", FAKE_CLI_SCRIPT)
        log = self.root / "argv.log"

        # Codex preset places -m AFTER `exec`
        codex_spec = resolve_agent("codex-test", {"preset": "codex", "enabled": True, "model": "gpt-5.4"}, self.root)
        codex_spec["argv"][0] = str(cli)
        codex_spec["env"] = {"FAKE_CLI_LOG": str(log)}
        res = CliAdapter(codex_spec, 10).ask("Check claim", str(self.root))
        self.assertTrue(res.ok, res.error)
        argv_codex = json.loads(log.read_text().splitlines()[-1])
        self.assertEqual(argv_codex[:3], ["exec", "-m", "gpt-5.4"])

        # Claude preset extracts result + modelUsage and never leaks stderr on failure
        claude_spec = resolve_agent("claude-test", {"preset": "claude", "enabled": True, "model": "opus"}, self.root)
        claude_spec["argv"][0] = str(cli)
        res_ok = CliAdapter(claude_spec, 10).ask("Check claim", str(self.root))
        self.assertTrue(res_ok.ok, res_ok.error)
        self.assertEqual(res_ok.meta.get("reportedModels"), ["claude-opus-5"])

        claude_spec["env"] = {"FAKE_CLI_FAIL": "1"}
        res_fail = CliAdapter(claude_spec, 10).ask("Check claim", str(self.root))
        self.assertFalse(res_fail.ok)
        self.assertNotIn("sk-should-never-leak", res_fail.error or "")

        # Timeout fails without retrying
        claude_spec["env"] = {"FAKE_CLI_SLEEP": "3"}
        res_to = CliAdapter(claude_spec, 0.3).ask("Slow", str(self.root))
        self.assertFalse(res_to.ok)
        self.assertIn("No automatic retry", res_to.error or "")

    def test_acp_adapter_sets_plan_mode_and_rejects_permissions(self):
        acp_bin = self._write_exec("fake_acp.py", FAKE_ACP_SCRIPT)
        spec = resolve_agent("acp-test", {
            "kind": "acp", "enabled": True, "argv": [str(acp_bin)], "mode": "plan", "family": "google",
        }, self.root)
        adapter = AcpAdapter(spec, 15)
        probe = adapter.probe()
        self.assertEqual(probe["handshake"], "ok")
        self.assertTrue(probe["readOnlyModeAvailable"])

        res = adapter.ask("Evaluate claim", str(self.root))
        self.assertTrue(res.ok, res.error)
        self.assertIn("permission rejected=True", res.text)
        self.assertEqual(res.meta.get("rejectedPermissions"), ["rm -rf /"])
        self.assertEqual(res.meta.get("reportedModels"), ["gemini-3.1-pro"])

        # Refuses to run when requested read-only mode is missing
        spec_no_plan = dict(spec, env={"FAKE_ACP_PLAN": "0"})
        res_refused = AcpAdapter(spec_no_plan, 15).ask("Evaluate claim", str(self.root))
        self.assertFalse(res_refused.ok)
        self.assertIn("refusing to run", res_refused.error or "")

    def test_mcp_stdio_and_http_sse_and_openai_http_adapters(self):
        # 1. MCP stdio
        mcp_bin = self._write_exec("fake_mcp.py", FAKE_MCP_STDIO_SCRIPT)
        spec_stdio = resolve_agent("mcp-stdio", {
            "kind": "mcp", "transport": "stdio", "enabled": True,
            "command": [str(mcp_bin)], "tool": "ask_agent",
            "arguments": {"prompt": "{prompt}"}, "resultPath": "answer",
            "readOnly": "enforced: fake read-only",
        }, self.root)
        ad_stdio = McpAdapter(spec_stdio, 15)
        pr = ad_stdio.probe()
        self.assertEqual(pr["handshake"], "ok")
        self.assertTrue(pr["toolPresent"])
        res = ad_stdio.ask("hello mcp", str(self.root))
        self.assertTrue(res.ok, res.error)
        self.assertIn("MCP stdio ok", res.text)
        self.assertEqual(res.meta.get("reportedModels"), ["gpt-5.4"])

        # 2. Local HTTP server serving both MCP streamable-HTTP (SSE) and OpenAI /v1/chat/completions
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                if self.path == "/v1/models":
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"data": [{"id": "deepseek-reasoner"}]}).encode())
                else:
                    self.send_response(404)
                    self.end_headers()

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length).decode())
                if self.path == "/mcp":
                    method = body.get("method")
                    rid = body.get("id")
                    if rid is None:
                        self.send_response(202)
                        self.end_headers()
                        return
                    if method == "initialize":
                        resp = {"jsonrpc": "2.0", "id": rid, "result": {
                            "protocolVersion": "2025-06-18", "serverInfo": {"name": "http-mcp"}, "capabilities": {"tools": {}}}}
                        self.send_response(200)
                        self.send_header("Content-Type", "application/json")
                        self.send_header("Mcp-Session-Id", "sess-http-1")
                        self.end_headers()
                        self.wfile.write(json.dumps(resp).encode())
                        return
                    if method == "tools/call":
                        # Return via SSE stream
                        ev = {"jsonrpc": "2.0", "id": rid, "result": {
                            "content": [{"type": "text", "text": json.dumps({"verdict": "SUPPORT", "summary": "sse ok"})}]}}
                        self.send_response(200)
                        self.send_header("Content-Type", "text/event-stream")
                        self.end_headers()
                        self.wfile.write(f"event: message\ndata: {json.dumps(ev)}\n\n".encode())
                        return
                if self.path == "/v1/chat/completions":
                    reply = {"model": "deepseek-reasoner",
                             "usage": {"prompt_tokens": 10, "completion_tokens": 20},
                             "choices": [{"message": {"content": json.dumps({"verdict": "PASS", "summary": "http ok"})}}]}
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps(reply).encode())
                    return
                self.send_response(404)
                self.end_headers()

            def do_DELETE(self):
                self.send_response(200)
                self.end_headers()

        httpd = socketserver.TCPServer(("127.0.0.1", 0), Handler)
        port = httpd.server_address[1]
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.shutdown)
        self.addCleanup(httpd.server_close)

        spec_mcp_http = resolve_agent("mcp-http", {
            "kind": "mcp", "transport": "http", "enabled": True,
            "url": f"http://127.0.0.1:{port}/mcp", "tool": "review",
            "readOnly": "remote-mcp",
        }, self.root)
        res_sse = McpAdapter(spec_mcp_http, 10).ask("check via sse", str(self.root))
        self.assertTrue(res_sse.ok, res_sse.error)
        self.assertIn("sse ok", res_sse.text)

        spec_http = resolve_agent("ds-http", {
            "kind": "http", "enabled": True,
            "baseUrl": f"http://127.0.0.1:{port}/v1", "model": "deepseek-reasoner",
        }, self.root)
        ad_http = HttpAdapter(spec_http, 10)
        self.assertTrue(ad_http.needs_inline_materials)
        self.assertTrue(ad_http.probe()["modelListed"])
        res_http = ad_http.ask("check via http", str(self.root))
        self.assertTrue(res_http.ok, res_http.error)
        self.assertEqual(res_http.meta.get("reportedModels"), ["deepseek-reasoner"])


class EngineAndProtocolTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / ".tools").mkdir()
        self.paper = self.root / "results.md"
        self.paper.write_text(
            "# Experiment Results\n\n"
            "Baseline accuracy: 81.2% (n=500, seed=42).\n"
            "Proposed method accuracy: 84.7% (p=0.03, paired bootstrap).\n"
            "Limitation: evaluated only on English short-context datasets.\n",
            encoding="utf-8",
        )
        cfg = {
            "storeDir": ".tools/debate-hub",
            "allowedRoots": ["."],
            "defaults": {"maxCalls": 30, "maxRounds": 2, "maxParallel": 2, "escalateBelowConfidence": 0.65},
            "agents": {
                "deb-anthropic": {"kind": "http", "enabled": True, "baseUrl": "http://invalid", "model": "claude-opus-5", "family": "anthropic"},
                "deb-openai": {"kind": "http", "enabled": True, "baseUrl": "http://invalid", "model": "gpt-5.4", "family": "openai"},
                "judge-google": {"kind": "http", "enabled": True, "baseUrl": "http://invalid", "model": "gemini-3.1-pro", "family": "google"},
                "judge-moonshot": {"kind": "http", "enabled": True, "baseUrl": "http://invalid", "model": "kimi-k3", "family": "moonshot"},
                "ext-board": {"kind": "external", "enabled": True, "family": "unknown"},
            },
        }
        (self.root / ".tools" / "debate-hub.json").write_text(json.dumps(cfg), encoding="utf-8")

    def _app(self, handler) -> DebateHubApp:
        return DebateHubApp(root=self.root, adapter_factory=lambda spec, timeout: _FakeAdapter(spec, handler))

    def test_evidence_anchoring_and_path_confinement(self):
        arts = snapshot_artifacts(["results.md"], [str(self.root)], str(self.root))
        self.assertEqual(len(arts), 1)
        reg = {a["path"] for a in arts}

        q_ok = verify_quote({"path": "results.md", "quote": "Proposed method accuracy: 84.7%"},
                            [str(self.root)], str(self.root), reg)
        self.assertTrue(q_ok["verified"])
        self.assertEqual(q_ok["matchKind"], "exact")
        self.assertEqual(q_ok["matchedLine"], 4)
        self.assertTrue(q_ok["registered"])

        q_ws = verify_quote({"path": "results.md", "quote": "Baseline accuracy:\n  81.2% (n=500, seed=42)."},
                            [str(self.root)], str(self.root), reg)
        self.assertTrue(q_ws["verified"])
        self.assertEqual(q_ws["matchKind"], "whitespace")

        q_fake = verify_quote({"path": "results.md", "quote": "Proposed method accuracy: 99.9%"},
                              [str(self.root)], str(self.root), reg)
        self.assertFalse(q_fake["verified"])
        self.assertEqual(q_fake["matchKind"], "missing")

        q_escape = verify_quote({"path": "../../etc/passwd", "quote": "root:"},
                                [str(self.root)], str(self.root), reg)
        self.assertFalse(q_escape["verified"])
        self.assertEqual(q_escape["matchKind"], "outside_roots")

        self.assertFalse(check_artifact_staleness(arts)["stale"])
        self.paper.write_text(self.paper.read_text() + "\nEdited\n", encoding="utf-8")
        self.assertTrue(check_artifact_staleness(arts)["stale"])

    def test_general_unanimous_skips_rebuttal_and_judge(self):
        calls: List[str] = []

        def handler(agent, prompt, cwd):
            calls.append(agent["id"])
            return CallResult(True, json.dumps({
                "verdict": "PASS", "confidence": 0.9, "summary": "Evidence supports claim.",
                "arguments": ["Paired bootstrap p=0.03"],
                "quotes": [{"path": "results.md", "quote": "Proposed method accuracy: 84.7% (p=0.03, paired bootstrap)."}],
                "crux": "Statistical significance", "decisiveEvidence": "Already present",
            }), meta={"seconds": 0.1})

        app = self._app(handler)
        created = app.call_tool("debate_create", {
            "preset": "general", "question": "Does the result hold?",
            "artifacts": ["results.md"],
            "debaters": ["deb-anthropic", "deb-openai"], "judges": ["judge-google"],
        })
        st = app.call_tool("debate_run", {"sessionId": created["sessionId"]})
        self.assertEqual(st["status"], "decided")
        self.assertFalse(st["divergence"]["divergent"])
        self.assertEqual(st["aiOutcome"]["resolutionKind"], "unanimous_independent")
        # Only 2 independent calls — no rebuttal and no judge wasted!
        self.assertEqual(len(calls), 2)
        self.assertTrue(st["independenceReport"]["crossFamilyDebaters"])

    def test_general_divergence_triggers_rebuttal_and_judge_and_html_card(self):
        prompts_seen: Dict[str, List[str]] = {}

        def handler(agent, prompt, cwd):
            prompts_seen.setdefault(agent["id"], []).append(prompt)
            aid = agent["id"]
            if aid == "deb-anthropic":
                return CallResult(True, json.dumps({
                    "verdict": "PASS", "confidence": 0.8, "summary": "Accuracy improved by 3.5%.",
                    "arguments": ["84.7% vs 81.2%"],
                    "quotes": [{"path": "results.md", "quote": "Proposed method accuracy: 84.7% (p=0.03, paired bootstrap)."}],
                    "crux": "Generalization scope", "decisiveEvidence": "Multilingual test",
                }))
            if aid == "deb-openai":
                return CallResult(True, json.dumps({
                    "verdict": "FAIL", "confidence": 0.75, "summary": "Scope too narrow and fake quote test.",
                    "arguments": ["Only English short-context", "Claimed 99% speedup"],
                    "quotes": [
                        {"path": "results.md", "quote": "Limitation: evaluated only on English short-context datasets."},
                        {"path": "results.md", "quote": "FABRICATED QUOTE NOT IN FILE"},
                    ],
                    "crux": "Generalization scope", "decisiveEvidence": "Long-context benchmark",
                }))
            if aid == "judge-google":
                # Verify judge prompt flagged the fabricated quote!
                self.assertIn("[UNVERIFIED QUOTE", prompt)
                self.assertIn("[VERIFIED exact", prompt)
                return CallResult(True, json.dumps({
                    "verdict": "ESCALATE_HUMAN", "confidence": 0.55,
                    "summary": "Accuracy gain is verified, but whether English-only scope is acceptable is a value judgment.",
                    "coreCrux": "Is English-only evaluation sufficient for the target venue?",
                    "winningArguments": ["84.7% vs 81.2% is verified"],
                    "quotes": [{"path": "results.md", "quote": "Limitation: evaluated only on English short-context datasets."}],
                    "decisiveEvidence": "Venue scope decision or multilingual check",
                    "valueJudgment": True, "needsHuman": True, "needsHumanReason": "Venue scope is a human decision",
                }))
            raise AssertionError(aid)

        app = self._app(handler)
        created = app.call_tool("debate_create", {
            "preset": "general", "title": "Scope & Accuracy Check",
            "question": "Should we claim general improvement? </script> test",
            "artifacts": ["results.md"],
            "debaters": ["deb-anthropic", "deb-openai"], "judges": ["judge-google"],
            "maxRounds": 1,
        })
        sid = created["sessionId"]
        st = app.call_tool("debate_run", {"sessionId": sid})
        self.assertTrue(st["divergence"]["divergent"])
        self.assertEqual(st["status"], "awaiting_human")
        self.assertTrue(st["independenceReport"]["crossFamilyJudge"])
        self.assertIsNotNone(st["card"])

        # Verify generated local HTML card + design.json
        html_path = Path(st["card"]["htmlPath"])
        design_path = Path(st["card"]["designPath"])
        self.assertTrue(html_path.is_file())
        self.assertTrue(design_path.is_file())
        html_text = html_path.read_text(encoding="utf-8")
        # No external scripts/stylesheets; </script> escaped in embedded payload; AI section collapsed
        self.assertNotIn("<script src=", html_text)
        self.assertIn("<\\/script>", html_text)
        self.assertIn('<details class="ai" id="ai-details">', html_text)
        self.assertNotIn('<details class="ai" id="ai-details" open', html_text)

        # Verify embedded JavaScript parses cleanly with node --check!
        m = re.search(r"<script>\n(.*?)\n</script>", html_text, flags=re.DOTALL)
        self.assertIsNotNone(m)
        js_tmp = self.root / "card_check.js"
        js_tmp.write_text(m.group(1), encoding="utf-8")
        chk = subprocess.run(["node", "--check", str(js_tmp)], capture_output=True, text=True)
        self.assertEqual(chk.returncode, 0, chk.stderr)

        # Pending human list contains this session
        pending = app.call_tool("debate_human_pending", {})["pending"]
        self.assertEqual([p["sessionId"] for p in pending], [sid])

        # Simulate downloaded JSON from HTML card and submit via answersFile
        dl = self.root / f"{sid}_human_decisions.json"
        dl.write_text(json.dumps({
            "schemaVersion": 1, "sessionId": sid, "preset": "general",
            "answers": [{
                "verdict": "SUPPORT", "selectedCandidateId": None,
                "rationale": "Scope narrowed to English short-context in abstract; verified accuracy gain stands.",
                "blindPassFirst": True, "aiRevealedBeforeSubmit": False,
            }],
        }), encoding="utf-8")

        # Staleness guard: mutate primary artifact -> submit must fail unless allowStale=True
        original = self.paper.read_text(encoding="utf-8")
        self.paper.write_text(original + "\nChanged after debate\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            app.call_tool("debate_human_submit", {"sessionId": sid, "answersFile": str(dl)})
        # Restore file -> submit succeeds and records humanDecision separately from aiOutcome
        self.paper.write_text(original, encoding="utf-8")
        sub = app.call_tool("debate_human_submit", {"sessionId": sid, "answersFile": str(dl)})
        self.assertEqual(sub["status"], "human_decided")
        self.assertEqual(sub["humanDecision"]["resolutionKind"], "human_adjudicated")
        self.assertTrue(sub["humanDecision"]["blindPassFirst"])

    def test_topic_tournament_position_swap_elo_and_mandatory_human_approval(self):
        def handler(agent, prompt, cwd):
            if agent["id"].startswith("deb-"):
                return CallResult(True, json.dumps({
                    "summary": "Strong case", "arguments": ["High novelty"],
                    "rivalWeaknesses": ["Expensive"], "ownRisks": ["Needs ablation"],
                    "quotes": [{"path": "results.md", "quote": "Baseline accuracy: 81.2% (n=500, seed=42)."}],
                    "decisiveEvidence": "Run 1-day pilot",
                }))
            # Judge: consistently prefer Idea Alpha over Idea Beta,
            # but ALWAYS pick OPTION_1 (position bias!) when Idea Gamma is involved!
            if "Idea Gamma" in prompt:
                winner = "OPTION_1"
            else:
                opt1_block = prompt.split("=== OPTION 2:")[0]
                winner = "OPTION_1" if "Idea Alpha" in opt1_block else "OPTION_2"
            return CallResult(True, json.dumps({
                "winner": winner, "confidence": 0.82, "summary": "Pairwise comparison",
                "coreCrux": "Feasibility vs ceiling", "decisiveEvidence": "Pilot accuracy",
                "quotes": [],
            }))

        app = self._app(handler)
        created = app.call_tool("debate_create", {
            "preset": "topic_tournament",
            "question": "Choose the strongest paper direction",
            "artifacts": ["results.md"],
            "debaters": ["deb-anthropic", "deb-openai"],
            "judges": ["judge-google"],
            "candidates": [
                {"id": "alpha", "title": "Idea Alpha", "summary": "Sparse routing"},
                {"id": "beta", "title": "Idea Beta", "summary": "Dense distillation"},
                {"id": "gamma", "title": "Idea Gamma", "summary": "Prompt tuning"},
            ],
            "swapPositions": True,
        })
        st = app.call_tool("debate_run", {"sessionId": created["sessionId"]})
        # Topic selection ALWAYS requires human approval
        self.assertEqual(st["status"], "awaiting_human")
        self.assertEqual(st["matchCount"], 3)
        inconsistent = st["decisionBrief"]["positionInconsistentMatches"]
        self.assertEqual(len(inconsistent), 2)  # Both matches involving Gamma flipped under swap!
        ranked = st["decisionBrief"]["aiRecommendation"]["rankedCandidates"]
        elo_by_id = {r["candidateId"]: r["elo"] for r in ranked}
        self.assertGreater(elo_by_id["alpha"], elo_by_id["beta"])

    def test_challenge_adjudication_same_family_judge_escalates(self):
        def handler(agent, prompt, cwd):
            return CallResult(True, json.dumps({
                "verdict": "RESOLVED", "confidence": 0.95, "summary": "Looks resolved",
                "arguments": ["Checked"], "coreCrux": "p-value",
                "quotes": [{"path": "results.md", "quote": "Proposed method accuracy: 84.7% (p=0.03, paired bootstrap)."}],
                "decisiveEvidence": "None", "needsHuman": False, "valueJudgment": False,
            }))

        app = self._app(handler)
        # Executor is anthropic, judge is ALSO deb-anthropic (same family) -> critical challenge MUST escalate!
        created = app.call_tool("debate_create", {
            "preset": "challenge_adjudication",
            "question": "Is CH-101 resolved?",
            "artifacts": ["results.md"],
            "executorFamily": "anthropic",
            "debaters": ["deb-openai"],
            "judges": ["deb-anthropic"],
            "challenge": {
                "challengeId": "CH-101", "claimId": "CL-01", "severity": "critical",
                "claimText": "Method beats baseline significantly",
                "challengeDescription": "Check whether significance test exists",
                "defenderRebuttal": {
                    "summary": "Paired bootstrap reported",
                    "quotes": [{"path": "results.md", "quote": "Proposed method accuracy: 84.7% (p=0.03, paired bootstrap)."}],
                },
            },
        })
        st = app.call_tool("debate_run", {"sessionId": created["sessionId"]})
        self.assertEqual(st["status"], "awaiting_human")
        self.assertTrue(any("not verified cross-family" in r for r in st["aiOutcome"]["escalationReasons"]))

    def test_open_board_independence_filter_and_external_judge(self):
        app = self._app(lambda *_: CallResult(False, "", "should not call driven adapter"))
        created = app.call_tool("debate_create", {
            "preset": "general", "question": "Open board debate",
            "artifacts": ["results.md"],
        })
        sid = created["sessionId"]
        app.call_tool("debate_board_join", {"sessionId": sid, "agentId": "cursor-agent", "role": "debater", "model": "claude-opus-5"})
        app.call_tool("debate_board_join", {"sessionId": sid, "agentId": "codex-agent", "role": "debater", "model": "gpt-5.4"})
        app.call_tool("debate_board_join", {"sessionId": sid, "agentId": "gemini-judge", "role": "judge", "model": "gemini-3.1-pro"})

        # cursor-agent posts Phase 1 independent assessment
        post1 = app.call_tool("debate_board_post", {
            "sessionId": sid, "agentId": "cursor-agent", "phase": "independent",
            "verdict": "SUPPORT", "confidence": 0.85, "summary": "Verified 84.7%",
            "quotes": [{"path": "results.md", "quote": "Proposed method accuracy: 84.7% (p=0.03, paired bootstrap)."}],
        })
        self.assertEqual(post1["quoteSummary"]["verifiedCount"], 1)

        # codex-agent reads BEFORE posting -> cursor-agent's independent post MUST be hidden!
        read_before = app.call_tool("debate_board_read", {"sessionId": sid, "requesterId": "codex-agent"})
        self.assertTrue(read_before["independenceFilterApplied"])
        self.assertEqual(read_before["hiddenIndependentEntries"], 1)
        self.assertEqual(len(read_before["entries"]), 0)

        # codex-agent posts its own independent assessment -> now both posts are visible!
        app.call_tool("debate_board_post", {
            "sessionId": sid, "agentId": "codex-agent", "phase": "independent",
            "verdict": "OPPOSE", "confidence": 0.75, "summary": "English-only limitation",
            "quotes": [{"path": "results.md", "quote": "Limitation: evaluated only on English short-context datasets."}],
        })
        read_after = app.call_tool("debate_board_read", {"sessionId": sid, "requesterId": "codex-agent"})
        self.assertFalse(read_after["independenceFilterApplied"])
        self.assertEqual(len(read_after["entries"]), 2)
        self.assertTrue(read_after["divergence"]["divergent"])

        # gemini-judge posts ruling -> cross-family resolved!
        app.call_tool("debate_board_post", {
            "sessionId": sid, "agentId": "gemini-judge", "phase": "judge",
            "verdict": "SUPPORT", "confidence": 0.88, "summary": "Gain holds within stated English scope.",
            "quotes": [{"path": "results.md", "quote": "Proposed method accuracy: 84.7% (p=0.03, paired bootstrap)."}],
            "needsHuman": False,
        })
        st = app.call_tool("debate_status", {"sessionId": sid})
        self.assertEqual(st["status"], "decided")
        self.assertTrue(st["independenceReport"]["crossFamilyJudge"])
        self.assertEqual(st["aiOutcome"]["resolutionKind"], "independent_judge_resolved")


class LiveMcpServerAndSetupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / "config").mkdir()
        (self.root / "config" / "debate-hub.example.json").write_text(
            (ROOT / "config" / "debate-hub.example.json").read_text(encoding="utf-8"), encoding="utf-8"
        )
        (self.root / "note.md").write_text("Key finding: latency dropped by 40%.\n", encoding="utf-8")

    def test_real_stdio_mcp_server_handshake_and_tools(self):
        env = os.environ.copy()
        env["DEBATE_HUB_ROOT"] = str(self.root)
        peer = StdioPeer(["python3", str(HUB_DIR / "server.py")], cwd=str(self.root), env=env)
        self.addCleanup(peer.close)

        init = peer.request("initialize", {
            "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}, 10)
        self.assertEqual(init["serverInfo"]["name"], "debate-hub")
        peer.notify("notifications/initialized", {})

        tools = peer.request("tools/list", {}, 10)["tools"]
        names = {t["name"] for t in tools}
        self.assertEqual(names, {
            "debate_agents_list", "debate_create", "debate_run",
            "debate_board_join", "debate_board_read", "debate_board_post",
            "debate_status", "debate_human_pending", "debate_human_card", "debate_human_submit",
        })

        created = peer.request("tools/call", {
            "name": "debate_create",
            "arguments": {"question": "Verify latency claim", "artifacts": ["note.md"]},
        }, 10)
        self.assertFalse(created.get("isError", False))
        sid = created["structuredContent"]["sessionId"]

        resources = peer.request("resources/list", {}, 10)["resources"]
        self.assertTrue(any(r["uri"] == f"debate://session/{sid}" for r in resources))
        read_res = peer.request("resources/read", {"uri": f"debate://session/{sid}"}, 10)
        self.assertIn("Verify latency claim", read_res["contents"][0]["text"])

    def test_enable_script_is_idempotent_and_preserves_existing_servers(self):
        (self.root / ".mcp.json").write_text(json.dumps({"mcpServers": {"codex": {"type": "stdio"}}}), encoding="utf-8")
        (self.root / ".codex").mkdir()
        (self.root / ".codex" / "config.toml").write_text('[mcp_servers.claude_reviewer]\ncommand = "py"\n', encoding="utf-8")

        enable_debate_hub.init_config(self.root)
        self.assertTrue((self.root / ".tools" / "debate-hub.json").is_file())
        # Second call preserves user edits
        (self.root / ".tools" / "debate-hub.json").write_text('{"custom": true}\n', encoding="utf-8")
        enable_debate_hub.init_config(self.root)
        self.assertEqual((self.root / ".tools" / "debate-hub.json").read_text().strip(), '{"custom": true}')

        enable_debate_hub.register_claude(self.root)
        enable_debate_hub.register_claude(self.root)
        mcp = json.loads((self.root / ".mcp.json").read_text())
        self.assertIn("codex", mcp["mcpServers"])
        self.assertIn("debate-hub", mcp["mcpServers"])

        enable_debate_hub.register_codex(self.root)
        enable_debate_hub.register_codex(self.root)
        toml = (self.root / ".codex" / "config.toml").read_text()
        self.assertIn("[mcp_servers.claude_reviewer]", toml)
        self.assertEqual(toml.count('[mcp_servers."debate-hub"]'), 1)

    def test_codex_registration_preserves_existing_unquoted_plugin_table(self):
        config = self.root / ".codex" / "config.toml"
        config.parent.mkdir()
        original = '[mcp_servers.debate-hub]\ncommand = "custom-python"\n'
        config.write_text(original, encoding="utf-8")
        enable_debate_hub.register_codex(self.root)
        self.assertEqual(config.read_text(encoding="utf-8"), original)


if __name__ == "__main__":
    unittest.main()
