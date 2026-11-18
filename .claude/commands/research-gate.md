---
description: Run a staged research project with saved artifacts, verbatim evidence and version-bound approvals.
argument-hint: [可选：研究目标或继续当前目录（如「继续当前 research-gate 工作区」）]
disable-model-invocation: true
---

The user invoked `/research-gate`. Activate the gated research workflow for this task.

Task / goal input from user: $ARGUMENTS

# Steps

1. **Load the modular gate skill.** Read `$RESEARCH_ROOT/.claude/skills/research-gate/SKILL.md`
   and its `references/workflow.md`, `references/gates.md`, and `references/artifacts-and-ids.md`.
2. **Initialize or reconstruct from disk.**
   - Run `python3 "$RESEARCH_ROOT/.claude/skills/research-gate/scripts/research_gate.py" status --root .`
     if `.research-gate/state.json` already exists, followed by `continue --root .`.
   - Otherwise initialize with `init --root . --goal "..."` using `$ARGUMENTS` (or ask if no goal is supplied) and run `preflight --root .` and `continue --root .`.
3. **Execute stage by stage under gate control.**
   - Select the relevant `recommendedSkills` from `continue`. Use `retrievalIntents` to identify the searches needed before drafting. At `review`, follow `reviewInstruction` and wait for the independent reviewer's reply before recording it.
   - Register every retrieved source (`source`) and retrieval action (`retrieval`) before referencing them.
   - Fill the stage artifact using `templates/` ledgers (`EVD-*` with exact backticked verbatim anchors, `CLM-*`, `GAP-*`, `DEC-*`, `SCN-*`).
   - Run `gate <stage> --root .` before advancing. Stop and fix on the first failing gate.
4. **Enforce SHA-256-bound approvals & stage boundaries.**
   - After `topic` gate passes, deliver the topic-approval report in the selected language and stop; only explicit user confirmation authorizes `approve --stage topic`.
   - When the plan gate returns `awaiting_approval`, deliver the frozen protocol summary and wait for explicit `approve --stage plan`.
   - Pass the approvalVersion from the report shown to the user when recording approval. At each passed gate boundary, report the closed boundary (`artifactHash`, `nextStage`) so the user can `/clear` and resume cleanly with `continue --root .`.
