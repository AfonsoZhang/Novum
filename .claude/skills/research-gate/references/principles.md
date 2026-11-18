# Principles and Authority Order

`research-gate` enforces the core invariants of `auto-research-system` in a modular host-executed controller.

## Authority order

When sources disagree, resolve in strict descending order:

1. Mechanical errors returned by `research_gate.py gate <stage>` for the current artifacts and approvals.
2. These principles (`references/principles.md`) and shared [research autonomy policy](../../shared-references/research-autonomy.md).
3. Stage gate contracts (`references/gates.md`) and ledger schemas (`references/artifacts-and-ids.md`).
4. Stage templates (`templates/*.md`).
5. Specialist skill instructions (`research-lit`, `experiment-plan`, `paper-writer`, etc.).
6. Agent reasoning or conversation summaries.

The host checks precheck findings and reviewer recommendations against the manuscript and original evidence. Assign a blocking stage when a confirmed contradiction or missing evidence prevents a retained claim from standing. A wording correction or narrower claim can resolve the issue using existing evidence.

## Evidence levels

| Level | Meaning | Admissible for claims in analysis/writing? |
|---|---|---|
| `verified` | Confirmed by primary empirical output, runnable check, or raw measurement file | Yes |
| `user-confirmed` | Explicitly confirmed by user decision recorded in `DEC-*` or approval record | Yes |
| `source-backed` | Grounded in a registered `SRC-*` snapshot with a verbatim backticked anchor | Yes |
| `inferred` | Working hypothesis or tentative deduction | No (must be upgraded or narrowed) |
| `missing` | No supporting evidence yet | No (record a `GAP-*`) |

## Core invariants

- **Truth lives on disk.** `.research-gate/state.json`, `.research-gate/retrievals.jsonl`, `.research-gate/sources/`, and `research/*.md` are canonical.
- **Topic & protocol approvals bind SHA-256 hashes.** Topic approval covers the proposal and contribution type. Plan approval covers the protocol and its required plan files. Use the version originally presented with the user reply.
- **No fabricated citations or evidence.** Citations in `.md`/`.tex` must match registered `SRC-*` entries; `EVD-*` verbatim anchors must match actual source text.
- **Rework requires real artifact changes.** When `rework --target <stage>` is active, a relevant stage input must change and the stage validators must pass. The host judges the scientific effect of that change.
- **Outward-facing actions stay with the user.** Never submit, publish, push, or spend beyond authorized scope automatically.
