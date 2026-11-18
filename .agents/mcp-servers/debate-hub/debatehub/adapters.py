"""Agent adapters: headless CLI, ACP, MCP (stdio/HTTP) and OpenAI-compatible HTTP.

Every adapter answers one prompt with one CallResult. None of them retries:
after a timeout or an ambiguous failure the request may already have been
executed and billed, so the runner records the failure instead.
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import VERSION
from .config import READ_ONLY_SYSTEM, infer_family
from .jsonrpc import HttpMcpTransport, RpcError, RpcTimeout, StdioPeer

MAX_ARGV_PROMPT = 120_000
MCP_PROTOCOL = "2025-06-18"
ACP_PROTOCOL = 1


class CallResult:
    def __init__(self, ok: bool, text: str = "", error: Optional[str] = None,
                 meta: Optional[Dict[str, Any]] = None):
        self.ok = ok
        self.text = text
        self.error = error
        self.meta = meta or {}

    def as_dict(self) -> Dict[str, Any]:
        return {"ok": self.ok, "error": self.error, "meta": self.meta}


def fail(message: str, **meta: Any) -> CallResult:
    return CallResult(False, "", message, meta)


def get_path(data: Any, path: Optional[str]) -> Any:
    if not path:
        return data
    cur = data
    for part in path.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return None
    return cur


def subst(value: Any, ctx: Dict[str, str]) -> Any:
    """Replace only known {placeholders}; JSON braces in arguments stay intact."""
    if isinstance(value, str):
        for key, rep in ctx.items():
            value = value.replace("{" + key + "}", rep)
        return value
    if isinstance(value, list):
        return [subst(v, ctx) for v in value]
    if isinstance(value, dict):
        return {k: subst(v, ctx) for k, v in value.items()}
    return value


def child_env(agent: Dict[str, Any]) -> Dict[str, str]:
    env = os.environ.copy()
    for name in agent.get("unsetEnv") or []:
        env.pop(name, None)
    for key, val in (agent.get("env") or {}).items():
        env[str(key)] = str(val)
    return env


def run_process(argv: List[str], stdin_text: Optional[str], cwd: str,
                env: Dict[str, str], timeout: float) -> Dict[str, Any]:
    try:
        proc = subprocess.Popen(argv, stdin=subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                cwd=cwd, env=env, start_new_session=True)
    except OSError as exc:
        return {"error": f"could not start {argv[0]}: {exc}"}
    try:
        out, err = proc.communicate(stdin_text.encode("utf-8") if stdin_text is not None else None,
                                    timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            proc.kill()
        proc.communicate()
        return {"error": f"timed out after {timeout:.0f}s; the call may already have run. No automatic retry."}
    return {"rc": proc.returncode, "stdout": out.decode("utf-8", "replace"),
            "stderr": err.decode("utf-8", "replace")}


class Adapter:
    def __init__(self, agent: Dict[str, Any], timeout: float):
        self.agent = agent
        self.timeout = float(agent.get("timeoutSeconds") or timeout)

    @property
    def needs_inline_materials(self) -> bool:
        return bool(self.agent.get("inlineMaterials", self.agent["kind"] == "http"))

    def ctx(self, prompt: str, cwd: str, outfile: str = "") -> Dict[str, str]:
        return {"prompt": prompt, "cwd": cwd, "model": str(self.agent.get("model") or ""),
                "outfile": outfile, "root": self.agent["root"],
                "executorModel": str(self.agent.get("executorModel") or "")}

    def ask(self, prompt: str, cwd: str) -> CallResult:  # pragma: no cover - interface
        raise NotImplementedError

    def probe(self) -> Dict[str, Any]:
        return {"handshake": "not-applicable"}


# ── headless CLI ─────────────────────────────────────────────────────────
class CliAdapter(Adapter):
    def build_argv(self, prompt: str, cwd: str, outfile: str) -> List[str]:
        ctx = self.ctx(prompt, cwd, outfile)
        argv = subst(list(self.agent["argv"]), ctx)
        if self.agent.get("model") and self.agent.get("modelArgs"):
            at = int(self.agent.get("modelArgsAt", 1))
            argv[at:at] = subst(list(self.agent["modelArgs"]), ctx)
        return argv

    def ask(self, prompt: str, cwd: str) -> CallResult:
        uses_stdin = self.agent.get("stdin") == "prompt"
        if not uses_stdin and len(prompt.encode("utf-8")) > MAX_ARGV_PROMPT:
            return fail("prompt too long to pass as an argument; use a stdin-capable agent")
        with tempfile.TemporaryDirectory(prefix="debate-hub-") as tmp:
            outfile = str(Path(tmp) / "last-message.txt")
            argv = self.build_argv(prompt, cwd, outfile)
            started = time.monotonic()
            res = run_process(argv, prompt if uses_stdin else None, cwd, child_env(self.agent), self.timeout)
            meta: Dict[str, Any] = {"seconds": round(time.monotonic() - started, 1)}
            if "error" in res:
                return fail(res["error"], **meta)
            if res["rc"] != 0:
                # stderr can carry provider details or credentials: never echo it.
                return fail(f"{argv[0]} exited with code {res['rc']}; no answer accepted", **meta)
            output = self.agent.get("output", "text")
            if output == "file":
                try:
                    text = Path(outfile).read_text(encoding="utf-8")
                except OSError:
                    return fail("agent produced no final message file", **meta)
            elif output == "json":
                data = self._parse_json(res["stdout"])
                if data is None:
                    return fail("agent output was not valid JSON", **meta)
                if self.agent.get("errorPath") and get_path(data, self.agent["errorPath"]):
                    return fail("agent reported an error result", **meta)
                models = get_path(data, self.agent.get("modelsPath")) if self.agent.get("modelsPath") else None
                if isinstance(models, dict) and models:
                    meta["reportedModels"] = sorted(models)
                value = get_path(data, self.agent.get("resultPath"))
                text = value if isinstance(value, str) else ""
            else:
                text = res["stdout"]
            if not text.strip():
                return fail("empty answer", **meta)
            return CallResult(True, text, None, meta)

    @staticmethod
    def _parse_json(stdout: str) -> Any:
        try:
            return json.loads(stdout)
        except ValueError:
            for line in reversed(stdout.strip().splitlines()):
                try:
                    return json.loads(line)
                except ValueError:
                    continue
        return None

    def probe(self) -> Dict[str, Any]:
        return {"handshake": "not-applicable", "note": "CLI agents are only checked for the executable"}


# ── Agent Client Protocol ────────────────────────────────────────────────
class AcpAdapter(Adapter):
    def _peer(self, cwd: str, sink: Dict[str, Any]) -> StdioPeer:
        def on_notification(method: str, params: Dict[str, Any]) -> None:
            if method != "session/update":
                return
            upd = params.get("update") or {}
            kind = upd.get("sessionUpdate")
            if kind == "agent_message_chunk":
                content = upd.get("content") or {}
                if content.get("type") == "text":
                    sink["chunks"].append(str(content.get("text") or ""))
            elif kind == "tool_call":
                sink["toolCalls"] += 1

        def on_request(method: str, params: Dict[str, Any]) -> Any:
            if method == "session/request_permission":
                options = params.get("options") or []
                title = str((params.get("toolCall") or {}).get("title") or "")[:200]
                sink["rejected"].append(title)
                choice = next((o for o in options if o.get("kind") == "reject_once"), None) or \
                    next((o for o in options if str(o.get("kind", "")).startswith("reject")), None)
                if choice:
                    return {"outcome": {"outcome": "selected", "optionId": choice.get("optionId")}}
                return {"outcome": {"outcome": "cancelled"}}
            raise RpcError("not permitted: debate participants are read-only", -32601)

        argv = subst(list(self.agent["argv"]), self.ctx("", cwd))
        return StdioPeer(argv, cwd=cwd, env=child_env(self.agent),
                         on_request=on_request, on_notification=on_notification)

    def _open(self, peer: StdioPeer, cwd: str, deadline: float) -> Dict[str, Any]:
        peer.request("initialize", {
            "protocolVersion": ACP_PROTOCOL,
            "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}, "terminal": False},
            "clientInfo": {"name": "debate-hub", "version": VERSION}},
            timeout=min(60.0, deadline - time.monotonic()))
        return peer.request("session/new", {"cwd": cwd, "mcpServers": []},
                            timeout=min(120.0, deadline - time.monotonic())) or {}

    def _configure(self, peer: StdioPeer, session: Dict[str, Any], deadline: float) -> Dict[str, Any]:
        sid = session.get("sessionId")
        info: Dict[str, Any] = {}
        wanted = self.agent.get("mode")
        if wanted:
            modes = [m.get("id") for m in ((session.get("modes") or {}).get("availableModes") or [])]
            mode_opt = next((o for o in session.get("configOptions") or [] if o.get("id") == "mode"), None)
            mode_vals = [o.get("value") for o in (mode_opt.get("options") or [])] if mode_opt else []
            if wanted in modes:
                peer.request("session/set_mode", {"sessionId": sid, "modeId": wanted},
                             timeout=min(30.0, deadline - time.monotonic()))
                info["mode"] = wanted
            elif wanted in mode_vals:
                peer.request("session/set_config_option", {"sessionId": sid, "configId": "mode", "value": wanted},
                             timeout=min(30.0, deadline - time.monotonic()))
                info["mode"] = wanted
            elif not self.agent.get("allowUnenforcedReadOnly"):
                raise RpcError(f"agent does not offer mode {wanted!r}; refusing to run without it")
        model = self.agent.get("model")
        models = (session.get("models") or {})
        current = models.get("currentModelId")
        if model:
            offered = [m.get("modelId") for m in models.get("availableModels") or []]
            options = next((o for o in session.get("configOptions") or [] if o.get("id") == "model"), None)
            if model in offered:
                peer.request("session/set_model", {"sessionId": sid, "modelId": model},
                             timeout=min(30.0, deadline - time.monotonic()))
            elif options and model in [o.get("value") for o in options.get("options") or []]:
                peer.request("session/set_config_option", {"sessionId": sid, "configId": "model", "value": model},
                             timeout=min(30.0, deadline - time.monotonic()))
            else:
                raise RpcError(f"agent does not offer model {model!r}")
            current = model
        elif not current:
            options = next((o for o in session.get("configOptions") or [] if o.get("id") == "model"), None)
            current = options.get("currentValue") if options else None
        if current:
            info["reportedModels"] = [current]
        return info

    def ask(self, prompt: str, cwd: str) -> CallResult:
        sink: Dict[str, Any] = {"chunks": [], "toolCalls": 0, "rejected": []}
        started = time.monotonic()
        deadline = started + self.timeout
        try:
            peer = self._peer(cwd, sink)
        except RpcError as exc:
            return fail(str(exc))
        sid = None
        try:
            session = self._open(peer, cwd, deadline)
            sid = session.get("sessionId")
            if not sid:
                return fail("agent returned no session id")
            meta = self._configure(peer, session, deadline)
            res = peer.request("session/prompt", {"sessionId": sid,
                                                  "prompt": [{"type": "text", "text": prompt}]},
                               timeout=deadline - time.monotonic()) or {}
            meta.update(seconds=round(time.monotonic() - started, 1), stopReason=res.get("stopReason"),
                        toolCalls=sink["toolCalls"], rejectedPermissions=sink["rejected"][:20])
            text = "".join(sink["chunks"])
            if res.get("stopReason") in ("refusal", "cancelled") or not text.strip():
                return CallResult(False, "", f"agent stopped ({res.get('stopReason')}) without an answer", meta)
            return CallResult(True, text, None, meta)
        except RpcTimeout as exc:
            if sid:
                try:
                    peer.notify("session/cancel", {"sessionId": sid})
                except RpcError:
                    pass
            return fail(str(exc), seconds=round(time.monotonic() - started, 1))
        except (RpcError, TypeError, AttributeError) as exc:
            return fail(f"ACP error: {exc}", seconds=round(time.monotonic() - started, 1))
        finally:
            peer.close()

    def probe(self) -> Dict[str, Any]:
        sink: Dict[str, Any] = {"chunks": [], "toolCalls": 0, "rejected": []}
        cwd = self.agent["root"]
        deadline = time.monotonic() + 90
        try:
            peer = self._peer(cwd, sink)
        except RpcError as exc:
            return {"handshake": "failed", "error": str(exc)}
        try:
            session = self._open(peer, cwd, deadline)
            modes = [m.get("id") for m in ((session.get("modes") or {}).get("availableModes") or [])]
            models = [m.get("modelId") for m in ((session.get("models") or {}).get("availableModels") or [])]
            if not models:
                opt = next((o for o in session.get("configOptions") or [] if o.get("id") == "model"), None)
                if opt:
                    models = [o.get("value") for o in opt.get("options") or [] if o.get("value")]
            wanted = self.agent.get("mode")
            return {"handshake": "ok", "modes": modes, "models": models[:40],
                    "readOnlyModeAvailable": (wanted in modes) if wanted else None,
                    "note": "initialize + session/new only; no prompt was sent"}
        except RpcError as exc:
            return {"handshake": "failed", "error": str(exc)}
        finally:
            peer.close()


# ── MCP tool exposing an agent ───────────────────────────────────────────
class McpAdapter(Adapter):
    def _transport(self, cwd: str):
        if self.agent.get("transport", "stdio") == "http":
            headers = dict(self.agent.get("headers") or {})
            env = self.agent.get("bearerTokenEnv")
            if env and os.environ.get(env):
                headers["Authorization"] = "Bearer " + os.environ[env]
            return HttpMcpTransport(self.agent["url"], headers)

        def on_request(method: str, params: Dict[str, Any]) -> Any:
            if method == "ping":
                return {}
            if method == "roots/list":
                return {"roots": []}
            raise RpcError("debate-hub does not provide sampling or elicitation", -32601)

        argv = subst(list(self.agent["command"]), self.ctx("", cwd))
        return StdioPeer(argv, cwd=self.agent["root"], env=child_env(self.agent), on_request=on_request)

    def _initialize(self, transport: Any, deadline: float) -> Dict[str, Any]:
        init = transport.request("initialize", {
            "protocolVersion": MCP_PROTOCOL, "capabilities": {},
            "clientInfo": {"name": "debate-hub", "version": VERSION}},
            timeout=min(60.0, deadline - time.monotonic())) or {}
        if isinstance(transport, HttpMcpTransport):
            transport.protocol_version = init.get("protocolVersion") or MCP_PROTOCOL
        transport.notify("notifications/initialized", {})
        return init

    def ask(self, prompt: str, cwd: str) -> CallResult:
        started = time.monotonic()
        deadline = started + self.timeout
        try:
            transport = self._transport(cwd)
        except RpcError as exc:
            return fail(str(exc))
        try:
            self._initialize(transport, deadline)
            args = subst(dict(self.agent.get("arguments") or {"prompt": "{prompt}"}), self.ctx(prompt, cwd))
            args = {k: v for k, v in args.items() if v != ""}
            res = transport.request("tools/call", {"name": self.agent["tool"], "arguments": args},
                                    timeout=deadline - time.monotonic()) or {}
            meta = {"seconds": round(time.monotonic() - started, 1)}
            texts = "".join(c.get("text", "") for c in res.get("content") or []
                            if isinstance(c, dict) and c.get("type") == "text")
            if res.get("isError"):
                return fail("tool reported an error: " + texts[:300], **meta)
            data = res.get("structuredContent")
            if data is None:
                try:
                    data = json.loads(texts)
                except ValueError:
                    data = None
            if self.agent.get("okPath"):
                status = get_path(data, self.agent["okPath"])
                if status != self.agent.get("okValue"):
                    reason = get_path(data, "reason")
                    return fail(f"tool status {status!r}" + (f": {str(reason)[:300]}" if reason else ""), **meta)
            if self.agent.get("resultPath"):
                value = get_path(data, self.agent["resultPath"])
                text = value if isinstance(value, str) else ""
            else:
                text = texts
            for key in ("reviewer_models",):
                if isinstance(get_path(data, key), list):
                    meta["reportedModels"] = get_path(data, key)
            if not text.strip():
                return fail("empty answer", **meta)
            return CallResult(True, text, None, meta)
        except RpcError as exc:
            return fail(f"MCP error: {exc}", seconds=round(time.monotonic() - started, 1))
        finally:
            transport.close()

    def probe(self) -> Dict[str, Any]:
        deadline = time.monotonic() + 60
        try:
            transport = self._transport(self.agent["root"])
        except RpcError as exc:
            return {"handshake": "failed", "error": str(exc)}
        try:
            init = self._initialize(transport, deadline)
            tools = (transport.request("tools/list", {}, timeout=30) or {}).get("tools") or []
            names = [t.get("name") for t in tools]
            return {"handshake": "ok", "server": init.get("serverInfo"), "tools": names,
                    "toolPresent": self.agent["tool"] in names,
                    "note": "initialize + tools/list only; no tool was called"}
        except RpcError as exc:
            return {"handshake": "failed", "error": str(exc)}
        finally:
            transport.close()


# ── OpenAI-compatible chat completions ───────────────────────────────────
class HttpAdapter(Adapter):
    def _headers(self) -> Dict[str, str]:
        headers = {"Content-Type": "application/json", **(self.agent.get("headers") or {})}
        env = self.agent.get("apiKeyEnv")
        if env and os.environ.get(env):
            headers["Authorization"] = "Bearer " + os.environ[env]
        return headers

    def ask(self, prompt: str, cwd: str) -> CallResult:
        body: Dict[str, Any] = {"model": self.agent["model"], "messages": [
            {"role": "system", "content": READ_ONLY_SYSTEM},
            {"role": "user", "content": prompt}]}
        for key in ("temperature", "max_tokens", "reasoning_effort"):
            if key in self.agent:
                body[key] = self.agent[key]
        url = self.agent["baseUrl"].rstrip("/") + "/chat/completions"
        req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"),
                                     headers=self._headers(), method="POST")
        started = time.monotonic()
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            return fail(f"HTTP {exc.code}; no answer accepted")
        except (urllib.error.URLError, OSError, ValueError) as exc:
            return fail(f"request failed or timed out ({type(exc).__name__}); it may have been billed. "
                        "No automatic retry.")
        meta: Dict[str, Any] = {"seconds": round(time.monotonic() - started, 1)}
        if data.get("model"):
            meta["reportedModels"] = [data["model"]]
        if isinstance(data.get("usage"), dict):
            meta["usage"] = {k: v for k, v in data["usage"].items() if isinstance(v, (int, float))}
        try:
            text = data["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError, TypeError):
            return fail("malformed chat completion response", **meta)
        if not text.strip():
            return fail("empty answer", **meta)
        return CallResult(True, text, None, meta)

    def probe(self) -> Dict[str, Any]:
        url = self.agent["baseUrl"].rstrip("/") + "/models"
        req = urllib.request.Request(url, headers=self._headers(), method="GET")
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            ids = [m.get("id") for m in data.get("data") or [] if isinstance(m, dict)]
            return {"handshake": "ok", "modelListed": self.agent["model"] in ids if ids else None}
        except (urllib.error.URLError, OSError, ValueError) as exc:
            return {"handshake": "failed", "error": type(exc).__name__}


ADAPTERS = {"cli": CliAdapter, "acp": AcpAdapter, "mcp": McpAdapter, "http": HttpAdapter}


def make_adapter(agent: Dict[str, Any], timeout: float) -> Adapter:
    if agent["kind"] not in ADAPTERS:
        raise ValueError(f"agent {agent['id']} ({agent['kind']}) is not driven by the hub")
    return ADAPTERS[agent["kind"]](agent, timeout)


def observed_family(agent: Dict[str, Any], meta: Dict[str, Any]) -> str:
    for model in meta.get("reportedModels") or []:
        fam = infer_family(str(model))
        if fam:
            return fam
    return agent.get("family") or "unknown"
