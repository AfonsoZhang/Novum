# `debate-hub` — Optional Multi-Agent Debate MCP Plugin

`debate-hub` is an **optional, disabled-by-default** MCP stdio server (Python 3 standard library only, no venv required) that adds evidence-anchored multi-agent debate and human-in-the-loop adjudication to `auto-research-system`.

## Design Guarantees

1. **Zero disruption when unused.** It is not enabled by `install.sh` and does not alter default single-reviewer workflows.
2. **Connect as many agents as possible — both directions:**
   - **Active driving (Hub → Agents):**
     - **Headless CLIs (`kind: "cli"`):** `claude`, `codex`, `gemini`, `kimi`, `agy`, `opencode`, or any custom read-only CLI command.
     - **Agent Client Protocol (`kind: "acp"`):** `gemini --acp`, `kimi acp`, `agy acp`, or any ACP-compliant agent over stdio (sets `plan`/read-only mode and rejects permission requests).
     - **MCP-over-stdio & Streamable-HTTP (`kind: "mcp"`):** drives other MCP servers that expose agent tools (e.g., bundled `codex-exec`, `claude-reviewer`, or any remote MCP server).
     - **OpenAI-compatible HTTP (`kind: "http"`):** connects any OpenAI-compatible endpoint (DeepSeek, Qwen, Ollama, vLLM, OpenRouter, etc.) with bounded raw artifact excerpts.
   - **Passive open board (Agents → Hub):** any MCP-capable host or agent (Claude Code, Codex, Gemini CLI, Kimi, Antigravity, OpenCode, Cursor, Windsurf, custom subagents) can connect directly to `debate-hub` and collaborate via `debate_board_join`, `debate_board_read`, and `debate_board_post`.
3. **Anti-contamination & reviewer independence:**
   - Phase 1 (`independent`) gives each debater ONLY raw primary artifact paths (or bounded raw excerpts for HTTP models)—no executor summaries, no peer outputs.
   - On the open board, `debate_board_read` hides other debaters' Phase 1 posts from any debater who has not yet submitted its own independent assessment.
   - Rebuttal rounds run **only when independent assessments diverge** (never fixed wasted rounds).
   - Model-family diversity is tracked across debaters and judges; same-family limitations are persisted explicitly.
4. **Verbatim evidence anchoring:** Every quote in `quotes: [{path, quote, line?}]` is verified verbatim against files inside `allowedRoots` on disk. Unverified or unanchored arguments are explicitly tagged and downgraded. Primary files are SHA-256 hashed at session creation and re-checked before accepting decisions.
5. **Human-in-the-loop adjudication (MCP tools + offline HTML card):**
   - `topic_tournament` always ends in `awaiting_human` (human topic approval is never bypassed) and swaps A/B presentation order to detect position bias before updating Elo.
   - `challenge_adjudication` tracks stable `challengeId`/`claimId`; executors cannot close their own major/critical challenges, and human rulings are recorded under `humanDecision` (`resolutionKind: "human_adjudicated"`), kept distinct from independent AI reviewer verdicts.
   - `debate_human_card` generates a local, single-file, offline `human-annotation-page`-style HTML card (`.html` + `.design.json`) with randomized side order, collapsed AI reference by default, verified quote badges, `localStorage` autosave, and JSON export that imports back via `debate_human_submit(answersFile=...)`.
6. **Fail closed, never auto-retry:** Ambiguous timeouts or failed child calls are recorded as errors without automatic retries (preventing silent double billing or unverified verdicts).

## Quick Setup (Opt-in)

1. Inspect detected local agents without enabling anything:
   ```bash
   python3 .agents/mcp-servers/debate-hub/server.py --list
   ```
2. Initialize local config (gitignored under `.tools/debate-hub.json`, all active agents start with `"enabled": false`):
   ```bash
   python3 scripts/enable_debate_hub.py --init
   ```
   Edit `.tools/debate-hub.json` and set `"enabled": true` only for the agents you want to allow (and choose distinct model families for debaters vs. judge).
3. Register the MCP server in the host(s) you use:
   ```bash
   # Print snippets for Claude Code, Codex, Gemini CLI, Agy, Cursor:
   python3 scripts/enable_debate_hub.py --snippets

   # Or register directly in project-local config (preserves existing servers):
   python3 scripts/enable_debate_hub.py --register claude
   python3 scripts/enable_debate_hub.py --register codex
   ```
4. Optionally run safe read-only protocol handshakes (no prompts sent) on enabled agents:
   ```bash
   python3 .agents/mcp-servers/debate-hub/server.py --probe
   ```

## MCP Tools

| Tool | Purpose |
|---|---|
| `debate_agents_list` | List configured agents, detected presets, availability, families, read-only level, and optional safe handshakes (`probe: true`). |
| `debate_create` | Create a persisted session (`general`, `topic_tournament`, or `challenge_adjudication`) with SHA-256 hashed primary artifacts. |
| `debate_run` | Execute driven agents (independent pass → divergence check → bounded rebuttal → independent judge → escalation + optional HTML card). |
| `debate_board_join` | Register an external MCP agent (`debater`, `judge`, or `observer`) on a session. |
| `debate_board_read` | Read session artifacts and entries with Phase 1 independence filtering. |
| `debate_board_post` | Post an independent assessment, rebuttal, or judge verdict; quotes are verified immediately against disk files. |
| `debate_status` | Inspect session state, independence report, budget, staleness, and brief (or list all sessions). |
| `debate_human_pending` | List sessions currently `awaiting_human` with debiased decision briefs. |
| `debate_human_card` | Generate local `.html` + `.design.json` human adjudication card (returns Linux and WSL Windows paths). |
| `debate_human_submit` | Record explicit human ruling (inline or imported from downloaded `*_human_decisions.json`). |

## MCP Resources

- `debate://sessions` — index of all sessions
- `debate://session/<sessionId>` — complete persisted session JSON
- `debate://session/<sessionId>/brief` — debiased decision brief JSON
