# codex-exec — the `codex` MCP server for this repository

Adapted from ARIS (`mcp-servers/codex-exec`, MIT; see `THIRD_PARTY_NOTICES.md`).

On the Claude Code and Antigravity hosts, skills reach Codex through the `codex`
MCP server (`codex` and `codex-reply` tools, exposed as `mcp__codex__codex` /
`mcp__codex__codex-reply` on Claude Code, or via `mcp_codex_*` / `call_mcp_tool`
on Antigravity): external review (`shared-references/reviewer-routing.md`) and
the built-in image handoff in `nature-figure`. This bridge provides both tools
by running each call as a `codex exec` subprocess and returns `{threadId, content}`.
If the optional Codex bridge is unavailable, the host can review with a fresh native subagent. Image generation follows the selected provider’s availability rules.

## Register

Requirements: `codex` on PATH and logged in (a version with `codex exec resume`);
Python 3.9+; no packages.

- **Claude Code (`install.sh --host claude`):** registers it for this project by
  rendering `.mcp.json` from `.mcp.json.example`; an existing `.mcp.json` is left
  untouched. To register it by hand instead, run from the repository root:

  ```bash
  claude mcp add codex -s project -- python3 "$PWD/.agents/mcp-servers/codex-exec/server.py"
  ```

- **Antigravity (`install.sh --host antigravity`):** registers it as a
  project-local plugin under `.agents/plugins/codex-reviewer/` (`plugin.json` +
  `mcp_config.json`), without modifying global `~/.gemini/config/mcp_config.json`.
  To register it globally by hand instead, run from the repository root:

  ```bash
  agy mcp add codex -- python3 "$PWD/.agents/mcp-servers/codex-exec/server.py"
  ```

A project-level `codex` server takes precedence over one registered at user level
under the same name. Claude Code asks you to approve project MCP servers the first
time it loads them.

Restart Claude Code (`claude mcp list` should show `codex … ✓ Connected`) or
Antigravity (`agy mcp list`). The server key must be `codex`, because skills call
the `codex` server. The Codex host runs a fresh native Codex subagent for review.

## What a call becomes

| MCP argument | `codex exec` |
|---|---|
| `prompt` | stdin (no argv limit) |
| `model` | `-m MODEL` |
| `config` `{"model_reasoning_effort": "high"}` | `-c model_reasoning_effort="high"` (nested objects become dotted keys) |
| `sandbox` | `--sandbox MODE` |
| `cwd` | `--cd DIR` |
| `codex-reply` `threadId` | `codex exec resume THREAD` **plus the model, config, sandbox and cwd the thread was created with**; `resume` alone would fall back to `config.toml` defaults, and reviewer routing relies on a continued thread keeping its reviewer model and effort |

The reviewer model and efforts come from `.tools/reviewer.json` (see
`config/reviewer.example.json`). Per-thread settings live in
`~/.codex/state/codex-exec/threads/<threadId>.json`, one file each
(`CODEX_EXEC_STATE_DIR` overrides the directory), so a continued thread survives a
bridge restart. Thread IDs that are not plain identifiers are rejected.

A failed turn (unknown model, auth, API error) comes back as `isError: true` with
Codex's own error text; reviewer routing treats it as review unavailable, never as
a verdict.

While a call runs, the bridge streams `codex/event` notifications and, when the
host passes a `progressToken`, a `notifications/progress` heartbeat every 15 s
(`CODEX_EXEC_PROGRESS_INTERVAL_SEC`), answers `ping`, and honours
`notifications/cancelled`. Notifications cannot override a host's hard tool
timeout; deep reviews at high effort can run 30+ minutes.

Not offered, because `codex exec` cannot honour them: `approval-policy`,
`base-instructions`, `developer-instructions`, `compact-prompt`.

Debugging: `CODEX_EXEC_DEBUG_LOG=/path/to/log` records every request and the exact
`codex exec` command line; `CODEX_BIN` points at a specific codex binary. Tests:
`python3 -m unittest discover -s tests -p test_claude_host.py` from the repository root.
