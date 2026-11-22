# Reviewer routing on interactive research hosts

Use the identity of the application executing the skill. Claude Code uses
`CLAUDE.md`, Codex uses `AGENTS.md`, and Antigravity uses `GEMINI.md`.
The skill installation order and the names of available MCP tools do not select
the host.

Reviewer selection belongs to the calling session. A subagent or external
Codex thread that receives the review assignment performs it directly and
returns its findings. In the standalone API runtime, its configured review
session already holds that assignment.

## Select a reviewer

1. For an authorized review, dispatch a fresh, read-only subagent on the current
   host. Supply the review question and primary artifact paths or permitted
   excerpts. Ask for the affected claim, exact file or passage, evidence,
   severity and the smallest justified correction.
2. Codex is the optional external reviewer. Select it when the user requests
   Codex or explicitly enables it for this project via `REVIEWER_BACKEND=codex`
   or `backend: codex` in `.tools/reviewer.json`. A per-task choice overrides
   configuration. The default backend is `native`. On a Codex host, use a
   fresh Codex subagent for either choice. Ignore legacy Claude/manual routes.
3. If external Codex is unavailable or returns no usable review, record that
   outcome and dispatch the local fresh subagent. Check the status of an
   ambiguous in-flight call before retrying. If native delegation is also
   unavailable, report the check as incomplete. Record who actually reviewed
   the materials. A same-family review can supply independent-context findings.
   A specifically requested cross-family check needs evidence of different
   model families.

## Calling external Codex

Confirm authorization for any unpublished materials. Discover the exposed
`codex` tool and start a fresh read-only thread with the project directory,
review brief and artifact paths. For a named skill include its absolute path.
Use the configured `REVIEWER_MODEL` and `REVIEWER_EFFORT_DEEP` or
`REVIEWER_EFFORT_REGULAR` (project keys `model`, `effort_deep`,
`effort_regular`) when provided. Use `codex-reply` with the returned
`threadId` for a follow-up on that review. A new independent audit starts fresh.

## Evidence and disagreements

Use [reviewer independence](reviewer-independence.md) and [review tracing](review-tracing.md)
for both routes. A full project review has [separate material and manuscript
briefs](split-review.md). Reviewers form their first judgment from the source
files without seeing the executor's interpretation or a peer verdict.
Verify each major finding against its source. When reviewers disagree about
a consequential claim, compare their cited passages before seeking a second
opinion. If the optional debate-hub is enabled and such a dispute remains,
use its passive evidence board with the host's fresh subagents and, when
selected, Codex. Keep other configured debate participants out of this review.
Limit rebuttals to the disputed claim. Only actual participants and returned
findings count.
