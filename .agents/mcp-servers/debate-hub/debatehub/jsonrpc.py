"""Minimal JSON-RPC 2.0 clients used to drive agents.

* ``StdioPeer``: newline-delimited JSON-RPC over a child process's stdio. Both
  MCP (stdio transport) and ACP use this framing, and both let the peer send
  requests back to us, so the peer answers incoming requests through a callback.
* ``HttpMcpTransport``: MCP streamable-HTTP client (JSON or SSE responses).

No automatic retries anywhere: a timed-out request may already have been
executed (and billed) by the peer, so the caller records it as failed.
"""
from __future__ import annotations

import collections
import itertools
import json
import os
import queue
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, Iterable, List, Optional


class RpcError(Exception):
    def __init__(self, message: str, code: Optional[int] = None):
        super().__init__(message)
        self.code = code


class RpcTimeout(RpcError):
    pass


RequestHandler = Callable[[str, Dict[str, Any]], Any]
NotificationHandler = Callable[[str, Dict[str, Any]], None]


class StdioPeer:
    def __init__(self, argv: List[str], cwd: Optional[str] = None,
                 env: Optional[Dict[str, str]] = None,
                 on_request: Optional[RequestHandler] = None,
                 on_notification: Optional[NotificationHandler] = None):
        self.argv = argv
        try:
            self.proc = subprocess.Popen(
                argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, cwd=cwd, env=env, start_new_session=True)
        except OSError as exc:
            raise RpcError(f"could not start {argv[0]}: {exc}") from exc
        self._ids = itertools.count(1)
        self._pending: Dict[Any, "queue.Queue[Optional[Dict[str, Any]]]"] = {}
        self._lock = threading.Lock()
        self._write_lock = threading.Lock()
        self.on_request = on_request
        self.on_notification = on_notification
        # stderr is kept only for local diagnostics; it is never returned to
        # callers because CLIs may print provider details or credentials there.
        self.stderr_tail: "collections.deque[str]" = collections.deque(maxlen=40)
        threading.Thread(target=self._read_loop, daemon=True).start()
        threading.Thread(target=self._drain_stderr, daemon=True).start()

    # ── reading ──────────────────────────────────────────────────────────
    def _drain_stderr(self) -> None:
        assert self.proc.stderr is not None
        try:
            for raw in self.proc.stderr:
                self.stderr_tail.append(raw.decode("utf-8", "replace").rstrip()[:500])
        except (OSError, ValueError):
            pass

    def _read_loop(self) -> None:
        assert self.proc.stdout is not None
        try:
            for raw in self.proc.stdout:
                line = raw.decode("utf-8", "replace").strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                for item in (msg if isinstance(msg, list) else [msg]):
                    if isinstance(item, dict):
                        self._dispatch(item)
        except (OSError, ValueError):
            pass
        with self._lock:
            pending = list(self._pending.values())
            self._pending.clear()
        for q in pending:
            q.put(None)

    def _dispatch(self, msg: Dict[str, Any]) -> None:
        if "method" in msg:
            if "id" in msg:
                threading.Thread(target=self._serve, args=(msg,), daemon=True).start()
            elif self.on_notification is not None:
                try:
                    self.on_notification(str(msg["method"]), msg.get("params") or {})
                except Exception:  # a broken observer must not kill the reader
                    pass
            return
        if "id" in msg:
            with self._lock:
                q = self._pending.pop(msg["id"], None)
            if q is not None:
                q.put(msg)

    def _serve(self, msg: Dict[str, Any]) -> None:
        try:
            if self.on_request is None:
                raise RpcError(f"method not supported: {msg['method']}", -32601)
            result = self.on_request(str(msg["method"]), msg.get("params") or {})
            reply = {"jsonrpc": "2.0", "id": msg["id"], "result": result}
        except RpcError as exc:
            reply = {"jsonrpc": "2.0", "id": msg["id"],
                     "error": {"code": exc.code or -32603, "message": str(exc)}}
        except Exception:
            reply = {"jsonrpc": "2.0", "id": msg["id"],
                     "error": {"code": -32603, "message": "client error"}}
        try:
            self._send(reply)
        except RpcError:
            pass

    # ── writing ──────────────────────────────────────────────────────────
    def _send(self, msg: Dict[str, Any]) -> None:
        data = (json.dumps(msg, ensure_ascii=False) + "\n").encode("utf-8")
        with self._write_lock:
            try:
                assert self.proc.stdin is not None
                self.proc.stdin.write(data)
                self.proc.stdin.flush()
            except (BrokenPipeError, OSError, ValueError) as exc:
                raise RpcError(f"peer closed its input: {exc}") from exc

    def notify(self, method: str, params: Dict[str, Any]) -> None:
        self._send({"jsonrpc": "2.0", "method": method, "params": params})

    def request(self, method: str, params: Dict[str, Any], timeout: float) -> Any:
        rid = next(self._ids)
        q: "queue.Queue[Optional[Dict[str, Any]]]" = queue.Queue(maxsize=1)
        with self._lock:
            self._pending[rid] = q
        self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        try:
            msg = q.get(timeout=max(0.01, timeout))
        except queue.Empty:
            with self._lock:
                self._pending.pop(rid, None)
            raise RpcTimeout(f"{method} timed out after {timeout:.0f}s; the peer may "
                             "still have executed it. No automatic retry.")
        if msg is None:
            code = self.proc.poll()
            raise RpcError(f"{self.argv[0]} exited (code {code}) before answering {method}")
        if "error" in msg:
            err = msg.get("error") or {}
            raise RpcError(str(err.get("message") or "error"), err.get("code"))
        return msg.get("result")

    def close(self) -> None:
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
        except OSError:
            pass
        if self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
            except OSError:
                self.proc.terminate()
            try:
                self.proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(self.proc.pid, signal.SIGKILL)
                except OSError:
                    self.proc.kill()
                try:
                    self.proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    pass
        for stream in (self.proc.stdout, self.proc.stderr):
            try:
                if stream:
                    stream.close()
            except OSError:
                pass


def iter_sse_events(lines: Iterable[bytes]) -> Iterable[str]:
    """Yield the data payload of each server-sent event."""
    data: List[str] = []
    for raw in lines:
        line = raw.decode("utf-8", "replace").rstrip("\r\n")
        if not line:
            if data:
                yield "\n".join(data)
                data = []
            continue
        if line.startswith(":"):
            continue
        field, _, value = line.partition(":")
        if field == "data":
            data.append(value[1:] if value.startswith(" ") else value)
    if data:
        yield "\n".join(data)


class HttpMcpTransport:
    """Streamable-HTTP MCP client: POST JSON-RPC, accept JSON or an SSE stream."""

    def __init__(self, url: str, headers: Optional[Dict[str, str]] = None):
        self.url = url
        self.headers = dict(headers or {})
        self.session_id: Optional[str] = None
        self.protocol_version: Optional[str] = None
        self._ids = itertools.count(1)

    def _post(self, msg: Dict[str, Any], timeout: float) -> Optional[Dict[str, Any]]:
        headers = {"Content-Type": "application/json",
                   "Accept": "application/json, text/event-stream", **self.headers}
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        if self.protocol_version:
            headers["MCP-Protocol-Version"] = self.protocol_version
        req = urllib.request.Request(self.url, data=json.dumps(msg).encode("utf-8"),
                                     headers=headers, method="POST")
        deadline = time.monotonic() + timeout
        try:
            resp = urllib.request.urlopen(req, timeout=timeout)
        except urllib.error.HTTPError as exc:
            raise RpcError(f"HTTP {exc.code} from MCP endpoint") from exc
        except (urllib.error.URLError, OSError) as exc:
            raise RpcError(f"MCP endpoint unreachable: {getattr(exc, 'reason', exc)}") from exc
        with resp:
            sid = resp.headers.get("Mcp-Session-Id")
            if sid:
                self.session_id = sid
            if "id" not in msg or resp.status == 202:
                return None
            ctype = resp.headers.get("Content-Type", "")
            if "text/event-stream" in ctype:
                for payload in iter_sse_events(resp):
                    if time.monotonic() > deadline:
                        raise RpcTimeout("MCP SSE response timed out; no automatic retry")
                    try:
                        event = json.loads(payload)
                    except ValueError:
                        continue
                    for item in (event if isinstance(event, list) else [event]):
                        if isinstance(item, dict) and item.get("id") == msg["id"] and "method" not in item:
                            return item
                raise RpcError("MCP SSE stream ended without a response")
            body = json.loads(resp.read().decode("utf-8") or "null")
            for item in (body if isinstance(body, list) else [body]):
                if isinstance(item, dict) and item.get("id") == msg["id"]:
                    return item
            raise RpcError("MCP HTTP response did not contain the request id")

    def notify(self, method: str, params: Dict[str, Any]) -> None:
        self._post({"jsonrpc": "2.0", "method": method, "params": params}, timeout=30)

    def request(self, method: str, params: Dict[str, Any], timeout: float) -> Any:
        rid = next(self._ids)
        msg = self._post({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}, timeout)
        if msg is None:
            raise RpcError(f"no response to {method}")
        if "error" in msg:
            err = msg.get("error") or {}
            raise RpcError(str(err.get("message") or "error"), err.get("code"))
        return msg.get("result")

    def close(self) -> None:
        if not self.session_id:
            return
        req = urllib.request.Request(self.url, method="DELETE",
                                     headers={"Mcp-Session-Id": self.session_id, **self.headers})
        try:
            urllib.request.urlopen(req, timeout=5).close()
        except (urllib.error.URLError, OSError):
            pass
