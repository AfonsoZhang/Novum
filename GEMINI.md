# Research project routing (Antigravity)

This guide applies when Antigravity runs the project. Its routing and approval rules apply within `$RESEARCH_ROOT`.

- **Host precedence.** When running inside Antigravity, this file (`GEMINI.md`) and
  the [Antigravity host contract](config/antigravity/host.md) take precedence over
  `AGENTS.md` and `config/codex/host.md`.
- **Default: standalone skills and scoped revisions.** Existing skills remain directly
  callable at the root and in child projects. Complete the current request and necessary
  verification without automatically starting a team or the next stage. For revisions,
  read existing artifacts and edit the requested scope; do not restart research.
- **Shared standards, loaded by impact.** Root and child-project work follows the
  [shared research policy](.agents/skills/shared-references/research-autonomy.md#local-changes).
  Load relevant clauses, verify affected dependencies, and reuse valid checks.
- **Working language.** Apply the shared [language policy](.agents/skills/shared-references/research-autonomy.md#working-language):
  Use English internally. User-facing reports default to Chinese. Honor a requested report language or choose one for the specified audience.
- **Research controller.** For root-level research coordination, stage assessment or
  cross-stage management, read [research-agent-team](.agents/skills/research-agent-team/SKILL.md).
  One main agent coordinates stages, specialist skills, execution and acceptance within
  the current request. Existing specialist skills remain directly callable.
- **Automatic mode.** Enable team assignments, authorized card selection and continuous
  execution only when the user explicitly activates automatic mode for this task
  (invoking `research-auto` / `/research-auto` / `$research-auto` counts as explicit activation).
  `research-autopilot` activates the post-topic autopilot variant: after topic approval
  the agent makes all research decisions and asks the user only for missing resources.
  `research-gate` activates the middle-tier modular gate controller
  (`.agents/skills/research-gate/`), where the host agent executes research while
  disk-backed gates, verbatim anchors and SHA-256-bound approvals govern progression.
  The controller defines completion and stopping conditions. Discussing or editing it,
  entering the directory, high reasoning effort, silence or past activation is not activation.
- **Human checkpoint after topic selection.** After fresh selection or reselection,
  follow the [topic-approval rule](.agents/skills/shared-references/topic-selection-policy.md#human-approval-after-topic-selection)
  and wait for the user's explicit decision. Automatic mode, timed defaults and decision
  recommendations cannot supply approval.
- **Child projects retain their existing workflow.** Ordinary child-project sessions do
  not inherit root team execution. A root task already in automatic mode may delegate
  scoped work there without changing the child's default workflow.
- **Single-call boundary.** Next-step and handoff suggestions do not authorize execution.
  Execute multiple stages only within an explicitly requested workflow. Complete necessary
  verification, self-checks, compilation and figure checks without expanding the task.
- `$RESEARCH_ROOT` denotes this file's directory. Substitute that path before running
  commands if the environment variable is unset.
- Preserve more specific child-project revision, freeze and data constraints.
- **Standing authorization: citation verification sub-agent.** When
  `paper-writer` requires an independent citation check (full paper, Final mode, or three
  or more citations; including its `intro-drafter` module), dispatch one fresh-context `research`
  subagent via `invoke_subagent` for that check without asking again. This covers only
  that verification step, not other subagent use.
- **Independent checks.** Report an independent check as complete only after the
  verifier returns findings that cover the current materials. Reuse a result that
  still covers them, or resume a pending request before dispatching another.
- **Research rework.** Check script findings and reviewer suggestions against the
  original evidence. Reopen the affected stage when a confirmed error or missing
  evidence compromises a claim the paper retains. Use existing evidence when it
  supports a correction to the manuscript.

- **Host adaptation.** Follow the [Antigravity host contract](config/antigravity/host.md) and [shared host rules](.claude/skills/shared-references/host-routing.md).

- **Skill & MCP setup.** Run `bash install.sh --host antigravity` from this root to build the Antigravity skill view in `.agents/skills/`, create `.tools/reviewer.json` if missing, and register the project-local `codex-reviewer` MCP plugin under `.agents/plugins/codex-reviewer/`. If `.agents/skills/` is absent, run `python3 scripts/build_antigravity.py` from this root.
