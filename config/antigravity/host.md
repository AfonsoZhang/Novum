# Antigravity host contract

This contract adapts host mechanics only and takes precedence over Claude-specific
examples in shared skills (and over `AGENTS.md` / `config/codex/host.md` when both
rule files are present in the repository). Keep all scientific policies, stages,
artifact formats, claim preservation, scope boundaries and the explicit
topic-approval checkpoint.

- Antigravity drafts and polishes directly. For review, use a fresh native subagent by default. External Codex is optional. In a split review assign separate material and manuscript briefs and record each reviewer and model family when known.

- Skills live in `.agents/skills/<name>/SKILL.md`. Interpret `/skill-name`,
  `$skill-name` or a direct skill name equivalently. Explicitly invoking
  `research-auto`, `research-autopilot` or `research-gate` activates that workflow
  for the current task only. Reading or listing skill files never activates it.
- `.claude/agents/*.md` are role instructions, not registered Antigravity subagent
  types. When delegation is authorized (or for standing-authorized citation
  verification), read the role file and launch a fresh-context subagent via
  `invoke_subagent` (`TypeName: "research"` for read-only audits and verification,
  or `TypeName: "self"` / `define_subagent` when write or command tools are
  needed), passing its scope, primary sources, writable files and acceptance
  criteria. Send follow-ups with `send_message` using the returned `conversationId`
  and wait reactively for completion instead of polling in a loop. Never invent
  Claude-specific `Agent`, `TeamCreate` or `SendMessage` tools.
- Replace Claude `Read`/`Grep`/`Glob`/`Bash`/`Write`/`Edit`/`WebSearch` with
  Antigravity's actual tools (`read_file`, `write_file`, `edit_file`,
  `run_command`, `search_web`, `call_mcp_tool`). Store untrusted text via file or
  edit tools, never shell interpolation.
- For structured clarifications, use `ask_question`; otherwise ask directly in the
  final response and wait for the next user message. Topic approval and other
  required human checkpoints always wait for an explicit user reply. Silence,
  timeout or dismissal never supplies approval.
- Long-running shell commands launched with `run_command` continue in the
  background and wake the agent automatically when done; inspect or stop them with
  `manage_task`, and use `schedule` for timers instead of shell `sleep`. Background
  tasks do not continue after the session ends.
- Apply the [shared reviewer routing](../../.claude/skills/shared-references/reviewer-routing.md) and [writing rules](../../.claude/skills/shared-references/writing-host.md). Discover the exposed Codex MCP tool or use Antigravity’s tool discovery for the registered server when external Codex is selected.

- Image generation: when `provider` is `antigravity` (or the user asks for
  Antigravity / Nano Banana), invoke Antigravity's built-in `image-generator`
  subagent directly via `invoke_subagent` instead of calling an external
  Antigravity MCP server. When `provider` is `imagegen`, use the configured `codex`
  MCP server if available. Preserve all figure QA and unavailable-tool rules.
- Resolve `RESEARCH_ROOT` from the root `GEMINI.md` / `AGENTS.md` location, not a
  child project's cwd. Commands must substitute the absolute root if the variable
  is unset.
