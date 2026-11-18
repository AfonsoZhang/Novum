# Stage Gate Contracts

Run `$GATE gate <stage> --root .` after completing a stage artifact. All stages require upstream gates to be `passed` and non-stale.

| Stage | Primary Artifact | Mandatory Prerequisites | Key Mechanical Checks |
|---|---|---|---|
| `topic` | `research/topic.md` | `preflight` passed | Completed proposal file, valid ledgers and no open topic-blocking gaps. The host assesses the question and its distinction from the closest work before presenting it for approval. |
| `literature` | `research/literature.md` | `topic` gate + SHA-256-bound `topic` approval | At least one `adversarial` `RET-*` retrieval; grounded `EVD-*` verbatim anchors in registered `SRC-*`; registered citations; no `literature`-blocking `GAP-*`. |
| `plan` | `research/protocol.md` | `literature` gate passed | Plan files declared in the protocol; RITP `RET-*` (`methodology`/`support`/`adversarial`) + `EVD-*` verbatim anchors; `venue` `RET-*` (or venue `GAP-*`) when `targetVenue` is set; `CLM-*` hypotheses; `SCN-*` acceptance criteria; `citations_in` membership; no `plan`-blocking `GAP-*`. |
| `experiment` | `research/execution.md` | `plan` gate + SHA-256-bound `plan` approval | Rework baseline change check if active; `check_run_records.py` for a committed run plan (no `running`/`pending`/`planned` attempts left); screening check for a committed `source-selection.json`; no `experiment`-blocking `GAP-*`. |
| `analysis` | `research/analysis.md` | `experiment` gate passed | Analysis files declared in the protocol; `EVD-*` verbatim anchors; `CLM-*` must use `verified`/`user-confirmed`/`source-backed` levels; body claims cannot rely only on `abstract`/`metadata` `Read Scope`; `citations_in` membership; no `analysis`-blocking `GAP-*`. |
| `writing` | `research/manuscript.md` | `analysis` gate passed | Grounded `EVD-*`/`CLM-*` (body claims require `full_text`/`raw_output` or explicit `abstract-only` scope narrowing); citation membership (`citations_in`) against registered `SRC-*`; `precheck.py` on `.tex`; `validate_figure.py` on plot scripts; no `writing`-blocking `GAP-*`. |
| `review` | `research/review.md` + `paper/PAPER_CLAIM_AUDIT.json` | `writing` gate passed | Fresh claim audit with verdict `PASS`, `WARN` or `NOT_APPLICABLE`. At least one completed independent review with its original verdict and summary. Registered citations and resolved review-blocking gaps. |
| `delivery` | `research/delivery.md` | `review` gate passed | Fresh claim audit, registered citations and resolved delivery-blocking gaps. The host verifies that the report explains reproduction and limitations in the chosen language. |

The protocol can assign extra files to any stage from `plan` through `delivery`. Its hash binds those choices, and plan approval also freezes the contents of files due at `plan`. Later files are checked and hashed when due. A version-1 workspace with an existing implied plan keeps its original profile requirements until its protocol includes a `Stage` / `Required artifact` table. An empty table explicitly selects just the standard stage records and audit. Amendments follow the existing plan approval setting.

Review and delivery use the audit emitted by `paper-claim-audit` in `paper/`, or the older workspace-root audit when the standard file is absent. Relative input paths resolve from the audit directory. Recovery checks the audited manuscript and result hashes before reporting completion.

The project settings in `status.scriptChecks` govern the three external validators listed above. All default to enabled. The writing gate reports findings from the enabled LaTeX and figure checks as warnings for the host to verify against the source and rendered output. A gate reports an error if an enabled validator cannot run or the figure validator detects a Python syntax error. Record reviewer suggestions in the review summary. An optional suggestion can remain there through delivery.

## Failure remediation

When a gate fails:

1. Stop immediately; do not proceed to downstream stages.
2. Read the JSON `errors` array returned by `gate <stage>`.
3. Either register missing `SRC-*` snapshots / `RET-*` records, add exact verbatim anchors to `EVD-*`, close `GAP-*` items with evidence or `DEC-*`, or fix failing Python validators (`check_run_records.py`, `precheck.py`, `validate_figure.py`).
4. Re-run `$GATE gate <stage> --root .`.
