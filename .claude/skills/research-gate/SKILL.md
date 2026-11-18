---
name: research-gate
description: >-
  Run research in stages with the host's specialist skills. A Python controller
  checks evidence anchors, binds approvals to artifact versions, and restores
  the next stage from project files.
disable-model-invocation: true
---

# Research Gate Controller (Middle Tier)

The current host agent uses its native tools and specialist skills to do the research. The bundled Python controller (`scripts/research_gate.py`) reads the project files, verifies the inputs for each stage, and records the next action.

## Modular layout

Read references and templates on demand; do not duplicate gate logic in prompts:

- [Principles & authority order](references/principles.md)
- [Stage gate contracts](references/gates.md)
- [Controller workflow & stage boundaries](references/workflow.md)
- [Artifact ledgers, IDs & verbatim anchors](references/artifacts-and-ids.md)
- Controller scripts: `scripts/research_gate.py`, `controller.py`, `gates.py`, `anchors.py`, `inputs.py`, `state.py`, `models.py`
- Stage templates: `templates/topic.md`, `literature.md`, `protocol.md`, `execution.md`, `analysis.md`, `manuscript.md`, `review.md`, `delivery.md`

## Controller CLI

Resolve the skill directory independently of `cwd`:

```bash
GATE="python3 $RESEARCH_ROOT/.claude/skills/research-gate/scripts/research_gate.py"
```

Core commands:

```bash
$GATE init --root . --goal "<research objective>" [--paper-type "<optional contribution label>"] [--venue "<target venue>"] [--report-language "<preferred language>"]
$GATE preflight --root .
$GATE status --root .
$GATE continue --root .
$GATE source --root . --id SRC-1 --title "..." --identity "..." --file path/to/snapshot.txt
$GATE retrieval --root . --id RET-1 --intent adversarial --provider openalex --query "..." --ref SRC-1 --status satisfied --source-id SRC-1
$GATE gate <stage> --root .
$GATE approve --stage topic --root . --version "<presented-version>" --by user --response "<explicit user decision>"
$GATE approve --stage plan --root . --version "<presented-version>" --by user --response "<frozen protocol approval>"
$GATE rework --target <stage> --root . --reason "<concrete diagnosis>"
```

The three validation scripts default to on in every project. When the user chooses a setting, run `$GATE check <name> on|off --root .`. At initialization, `--disable-check <name>` can be repeated. `status` shows the saved choices.

| Name | Script | When it runs |
|---|---|---|
| `run-records` | `check_run_records.py` | Experiment gate with planned and observed runs |
| `latex-integrity` | `precheck.py` | Writing gate with LaTeX files |
| `figures` | `validate_figure.py` | Writing gate with plot scripts |

Apply these choices to specialist calls within the gated workflow as well. The protocol still determines the required files. Gates continue to verify evidence, audit inputs and approvals. Enabling a previously skipped script makes its gate due for a check against the current files.

## Artifact & stage pipeline

```text
preflight -> topic -> [topic approval] -> literature -> plan -> [protocol approval] -> experiment -> analysis -> writing -> review -> delivery
```

## Non-negotiable rules

1. **Disk state + gate results are truth.** Never advance a stage because you remember doing it; run `$GATE gate <stage> --root .` and verify exit code `0`.
2. **Stop at the first failing gate.** Follow gate error messages back to the implicated artifact, source snapshot, or gap closure.
3. **Approvals are SHA-256 bound.** Natural language "continue" never approves `topic` or `plan`. Only `$GATE approve` records approval, and the presented version binds the contribution type and proposal, or the frozen protocol and its declared plan files.
4. **Verbatim anchor grounding.** Every `source-backed` or `verified` `EVD-*` row must carry a backticked verbatim substring present in its registered `SRC-*` snapshot or referenced local file.
5. **Stage boundary & clean context reconstruction.** After a gate passes, report the closed boundary (`artifactHash`, `nextStage`, any pending approval). The user may `/clear` the session and resume via `$GATE continue --root .` without relying on lossy compaction summaries.
