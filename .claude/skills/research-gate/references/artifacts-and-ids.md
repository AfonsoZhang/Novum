# Artifact Ledgers, IDs, and Verbatim Anchors

Stage Markdown files use pipe-delimited ledger tables parsed deterministically by `scripts/anchors.py`. Keep the exact column headers below so gates can audit them.

## Ledger ID dictionary

| Prefix | Meaning | Required Columns |
|---|---|---|
| `SRC-*` | Registered source or raw data file | Recorded via `research_gate.py source --id SRC-1 ...` |
| `RET-*` | Retrieval query & audit record | Record once with `research_gate.py retrieval`; cite the ID in stage prose |
| `EVD-*` | Grounded evidence item | `Evidence ID \| Source Ref \| Location \| [Read Scope \|] Level \| Verbatim Anchor \| Summary` |
| `CLM-*` | Claim or hypothesis | `Claim ID \| Statement \| Evidence IDs \| Level \| Scope` |
| `GAP-*` | Open gap or conflict | `Gap ID \| Description \| Blocking Stage \| Status \| Resolution` |
| `DEC-*` | Converged decision | `Decision ID \| Closes \| Source Type \| Rationale` |
| `SCN-*` | Acceptance or stopping scenario | `Scenario ID \| Criterion \| Status \| Evidence` |

Existing retrieval tables are read as references to their IDs. The latest matching JSONL record supplies the query details and status. Leave `Blocking Stage` empty on follow-up items that can remain open through delivery. An explicitly assigned stage blocks until the gap is resolved. Record a decision referencing the gap ID to close it. Each stage only records new gaps or changes.

## Verbatim anchor rules

1. Every `EVD-*` row with `Level` equal to `source-backed` or `verified` **must** contain at least one backticked verbatim substring `` `exact snippet` `` in its `Verbatim Anchor` column.
2. The snippet must be at least 4 characters long, must not be a generic single token (`status`, `code`, `true`, `false`, `ok`, pure numbers), and must not use `...` or `…` to elide text.
3. The exact substring must exist verbatim inside the file or snapshot identified by `Source Ref` (either a registered `SRC-*` ID or a valid workspace-relative path).
4. Unfilled template placeholders (`{{...}}`) cause the gate to fail. Delete unused template placeholder rows or replace them with real records.

## Read Scope (`abstract` vs `full_text`) rules

1. `EVD-*` tables accept an optional `Read Scope` column with values `full_text`, `abstract`, `raw_output`, `official_page`, or `metadata` (if omitted, `Location` equal to `abstract`/`摘要` or `metadata`/`bibtex` is also treated as shallow scope).
2. In `analysis`, `writing`, `review`, and `delivery`, any `CLM-*` claim referencing only `abstract`/`metadata` `EVD-*` rows (including upstream `EVD-*` items) is blocked unless the claim's `Scope` explicitly narrows it to `abstract-only` / `metadata-only` / `preliminary` (or `仅摘要` / `摘要级`).
