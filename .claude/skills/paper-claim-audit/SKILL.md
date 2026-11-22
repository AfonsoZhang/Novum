---
name: paper-claim-audit
description: Verify manuscript numbers, comparisons and scope against raw results, and pivotal empirical method claims against the code that produced them. Use for paper claim audits, method–code checks or submission review with a fresh-context reviewer.
argument-hint: "[paper-directory]"
allowed-tools: Agent, Bash(*), Read, Write, Edit, Grep, Glob, mcp__codex__codex
---

# Paper Claim Audit: Zero-Context Evidence Verification

Apply the shared [working-language policy](../shared-references/research-autonomy.md#working-language) to internal work and user reports.

When applying audit findings to manuscript edits, the author-side step uses [claim-preservation.md](../shared-references/claim-preservation.md). Preserve this audit’s zero-context boundary: the auditor still sees only paper and raw-evidence files, not revision history, author narratives or prior verdicts. Its generic protocol below asks for a precise scope mismatch; cross-version contribution checks happen after the audit, within an authorized revision task.

Verify that every claim in the paper matches raw evidence for: **$ARGUMENTS**

## Why This Exists

The executor writes experiments AND writes the paper. It "knows" what the results should be. This creates confirmation bias:
- Rounding 84.7% up to 85.3%
- Reporting best seed instead of average
- Citing metrics from a different experiment config
- Claiming "improves by 15%" when the delta is actually 12.8%

A **fresh reviewer with zero prior context** catches these because it has no expectations — it just compares paper text vs raw files.

## How This Differs From Other Audit Skills

| Skill | Question it answers |
|-------|-------------------|
| `analyze-results` | What does the data scientifically support? |
| **`/paper-claim-audit`** | **Does the paper report the data truthfully and precisely?** |

## Core Principle

**Zero-context, fresh reviewer.** The auditor receives ONLY:
- Manuscript source (LaTeX or Markdown)
- Raw result files (the evidence)
- For claims about an implemented empirical method, the run record, resolved
  config and relevant source files from the executed revision

It does NOT receive:
- ❌ EXPERIMENT_LOG.md
- ❌ EXPERIMENT_TRACKER.md
- ❌ AUTO_REVIEW.md
- ❌ NARRATIVE_REPORT.md
- ❌ Any executor summary or interpretation
- ❌ Any prior audit results
- ❌ Any conversation history

This is **stricter than reviewer-independence** — it's zero-context evidence audit.

## Workflow

### Step 1: Collect Files (Executor — Claude)

Locate paper and result files WITHOUT reading or interpreting them.

**Paper files** (claims) — paths shown relative to the shell's working
directory so you can find them with `ls`; when writing them into
`audited_input_hashes`, use paths relative to the paper dir (no `paper/`
prefix) per the "Submission Artifact Emission" section below:
```
paper/main.tex                # → hash key: main.tex
paper/sections/*.tex          # → hash key: sections/*.tex
paper/tables/*.tex (if separate)   # → hash key: tables/*.tex
```
For a Markdown manuscript, supply its actual source, such as
`research/manuscript.md`, and apply the same audit.

**Result files** (evidence):
```
results/*.json, results/*.jsonl, results/*.csv, results/*.tsv
outputs/*.json, outputs/*.csv
wandb-summary.json (if exists)
**/metrics.json, **/eval_results.json
**/config.yaml, **/args.json (experiment configs)
```

#### Method check

In a full claim audit, or when reviewing the relevant method, trace each
implementation choice on which an empirical conclusion depends. Examples
include enabling a component or selecting data for an evaluation.
Locate the run or attempt behind the result
and collect its recorded command, resolved settings and the relevant source
at the recorded revision. A clean checkout of that revision or a preserved
source snapshot can supply the code. Trace the executed branch, including
overrides. For example, for a validation-only threshold, identify the split
actually passed to the threshold selector. A matching output value or an
unused implementation cannot establish that claim.

**Exclude** (no summaries, no interpretations):
```
EXPERIMENT_LOG.md, EXPERIMENT_TRACKER.md, AUTO_REVIEW*.md
NARRATIVE_REPORT.md, PAPER_PLAN.md, findings.md
Any .md file that is an executor-written summary
```

### Step 1b: Deterministic integrity pre-check (Executor — Claude)

For LaTeX inputs, run the arithmetic and surface checks before the reviewer call:

```bash
python3 <this skill>/scripts/integrity/precheck.py --latex <paper .tex files> \
  --out-dir <paper dir>/integrity-precheck
```

It reports delta arithmetic, headline numbers absent from tables, GRIM/variance
impossibility, p values contradicting their statistic, identical tables and
leftover template strings, and writes `INTEGRITY_PRECHECK.md`. Every finding is
for the author to verify, not a verdict, and the checks see only what the regex
extractor finds (GRIM, for example, needs a percentage and a stated item count
in the same sentence).
Do not send its output to the reviewer (zero-context rule); list each finding in
the report under "Deterministic pre-check" with its status after checking.
Without scipy, only z-test p values are rechecked.

### Step 2: Fresh reviewer audit

The calling host uses [reviewer routing](../shared-references/reviewer-routing.md) to dispatch a new native subagent or an optional external Codex thread. If you already received this audit assignment as the reviewer, perform the following checks directly on the supplied artifact paths.

```text
    You are a paper-to-evidence auditor. You have ZERO prior context about
    this research. Verify quantitative claims against raw evidence. Check
    pivotal empirical method claims against the implementation used for the
    reported result, even when a claim contains no number.

    Paper files to read:
    [list manuscript source paths]

    Result files to read:
    [list .json/.csv/.yaml file paths]

    Method evidence to read: [list run records, commands, resolved configs
    and versioned source paths]. Follow the reported run through its entry
    point and overrides to the branch that produced the result. A function
    elsewhere in the repository cannot establish that it ran.
    Return method_checks with the manuscript claim and locator,
    run/attempt, code revision, config and file/symbol
    locators, observed behavior, and status (match, mismatch, or unverified).
    Identify missing evidence when the executed path cannot be established.

    ## Audit Protocol

    ### A. Extract Every Quantitative Claim
    For each number, percentage, comparison, or scope statement in the paper:
    - Location (section, table, caption, or inline text)
    - Exact claim text
    - The number or comparison being made

    ### B. Trace Each Claim to Evidence
    For each extracted claim, find the supporting raw data:
    - Which result file contains this number?
    - What is the EXACT value in that file?
    - Match status: exact_match / rounding_ok / mismatch

    ### C. Check These Specific Failure Modes

    1. **Number inflation**: Paper says 85.3%, raw file says 84.7%
       Rule: only standard rounding to displayed precision is allowed

    2. **Best-seed cherry-pick**: Paper says "achieves 90.2%" but
       that's the best of 5 seeds; mean is 87.1%
       Rule: check if paper specifies "average" / "best" / "median"

    3. **Config mismatch**: Paper compares Method A vs Baseline B,
       but they used different hyperparameters / datasets / splits
       Rule: verify config files show same settings for compared methods

    4. **Aggregation mismatch**: Paper says "average over 5 seeds"
       but result files show only 3 runs
       Rule: count actual runs vs claimed count

    5. **Delta error**: Paper says "improves by 15%" but
       actual delta is (85.3 - 73.1) / 73.1 = 16.7%
       Rule: verify arithmetic of all relative improvements

    6. **Caption-table mismatch**: Figure caption describes
       something different from what the figure/table actually shows
       Rule: cross-check every caption against its content

    7. **Scope mismatch**: An unqualified claim extends beyond the conditions
       established by the paper and raw results. Identify the exact asserted scope
       and evidence-supported scope. A statement explicitly bounded to the tested
       datasets is not an overclaim merely because their count is small.
       Rule: identify the smallest necessary correction and supported assertion
       that remains; do not require blanket qualifiers or broaden the verdict
       beyond the supplied evidence. Do not infer performance failure from an
       untested setting or claim to assess cross-revision drift without history.

    8. **Arithmetic impossibility**: a percentage, mean or SD that no integer
       count can produce at the stated n (GRIM/GRIMMER), or a p value that
       contradicts its own test statistic and degrees of freedom
       Rule: recompute and show the numbers used; a case that rounding can
       explain is ambiguous_mapping, not number_mismatch

    9. **Unit, direction and denominator drift**: percentage points reported
       as percent, a lower-is-better metric praised as an increase, or an
       all-task average restated for a favourable subset
       Rule: check each comparison's unit, metric direction and denominator

    10. **Duplicated or contradicting tables**: identical cells under different
        labels, or an appendix that recomputes a main-text quantity differently
        Rule: compare tables pairwise and appendix values against the body

    11. **Phantom or self-referential evidence**: a reported number with no
        result file or metric key, ground truth produced by the evaluated
        model, scores normalized by the model's own maximum, or placeholder
        data feeding a reported figure
        Rule: report missing_evidence or unsupported_claim with the file path

    12. **Pipeline residue**: template or generation strings left in the
        manuscript ("As an AI language model", "[INSERT", "TODO", "lorem ipsum")
        Rule: list each occurrence with its location

    ## Output Format (quantitative claims)
    For each quantitative claim, report:
    - claim_id: sequential number
    - location: section/table/figure
    - paper_text: exact quote from paper
    - paper_value: the number claimed
    - evidence_file: which raw file
    - evidence_value: the actual number
    - status: exact_match | rounding_ok | ambiguous_mapping |
              missing_evidence | config_mismatch | aggregation_mismatch |
              number_mismatch | scope_overclaim | unsupported_claim
    - details: explanation if not exact_match

    Return the overall verdict and its reason. A demonstrated material
    contradiction is FAIL. If any pivotal method
    claim lacks execution evidence and no material contradiction was found,
    return BLOCKED. Retain both verified findings and unresolved claims.
```

### Step 3: Write Report (Executor — Claude)

Parse the reviewer's response and write `PAPER_CLAIM_AUDIT.md`:

```markdown
# Paper Claim Audit Report

**Date**: [today]
**Auditor**: [actual reviewer model and effort] (fresh zero-context thread)
**Paper**: [manuscript title]

## Overall Verdict: [verdict from the decision table]

## Claims Verified: [N total]
- exact_match: [count]
- rounding_ok: [count]
- ambiguous_mapping: [count]
- missing_evidence: [count]
- mismatch: [count]

## Issues Found

### [FAIL/WARN] Claim #N: [description]
- **Location**: Section X / Table Y / Figure Z
- **Paper says**: "..."
- **Evidence shows**: ...
- **Status**: [status]
- **Fix**: [specific correction needed]

## All Claims (detailed)

| # | Location | Paper Value | Evidence Value | Status |
|---|----------|-------------|---------------|--------|
| 1 | Table 2 | 85.3% | 85.28% | rounding_ok |
| 2 | Abstract | "15% improvement" | 12.8% | number_mismatch |
| ... |
```

Include applicable method checks and their evidence locators in the report
and in `details.method_checks` of `PAPER_CLAIM_AUDIT.json`.

### Step 4: Print Summary

```
📋 Paper Claim Audit Complete

  Claims verified: 24
  exact_match:     18
  rounding_ok:      3
  ambiguous:         1
  ⚠️ mismatch:      2

  Overall: ⚠️ WARN

  See PAPER_CLAIM_AUDIT.md for details.
```

## When to Run

1. **After a draft with numbers is written** (e.g. by `paper-writer`)
2. **After a revision that changed numbers, tables or claims**
3. **Before submission** — final verification

## Applying findings

**Human in the loop: the user selects the fixes.** After delivering
findings, stop. Apply manuscript edits only to the severity levels or item IDs
the user names (e.g. "只改 major"); list the rest as open. Do not fold in minor
fixes or extra narrowing on the side.

### Advisory, Never Blocking

- `PASS` → continue normally
- `WARN` → print warning, continue, flag draft as "check numbers before submission"
- `FAIL` → print alert, continue, but do NOT mark as submission-ready

## Key Rules

- **Fresh thread EVERY run.** Never use `codex-reply`. Never carry context.
- **Zero executor interpretation.** Only file paths. No summaries.
- **Use primary evidence.** Supply raw results and run-linked implementation
  evidence. Exclude author summaries and prior reviews.
- **Rounding rule.** Only standard rounding to displayed precision. 84.7% → 84.7% or 85% is OK. 84.7% → 85.3% is NOT OK.
- **Identity.** Record the actual reviewer and family relation. A fresh native subagent can perform the audit. Claim cross-family review only when the identities support it.
- **Fix the evidence, not the wording.** Resolve a finding by correcting the number,
  adding the missing run or narrowing the claim; never by rewording so a check no
  longer matches. Family map: [integrity patterns](../shared-references/integrity-patterns.md).

## Review Tracing

After each native or external reviewer call, save the trace following [review tracing](../shared-references/review-tracing.md); never silently skip. Use `save_trace.sh` or write files directly to `.aris/traces/<skill>/<date>_run<NN>/`. Respect the `--- trace:` parameter (default: `full`).

## Submission Artifact Emission

This skill **always** writes `paper/PAPER_CLAIM_AUDIT.json`, regardless of
caller or detector outcome. Check both quantitative and applicable method
claims before choosing a verdict. Later revision and
pre-submission checks read this artifact at a predictable path.

Schema:

```json
{
  "audit_skill":      "paper-claim-audit",
  "verdict":          "PASS | WARN | FAIL | NOT_APPLICABLE | BLOCKED | ERROR",
  "reason_code":      "claims_verified | rounding_drift | missing_run_provenance | ...",
  "summary":          "One-line human-readable verdict summary.",
  "audited_input_hashes": {
    "main.tex":                              "sha256:...",
    "sections/5.evidence.tex":               "sha256:...",
    "/abs/path/to/results/run_2026_04_19.json": "sha256:..."
  },
  "trace_path":       ".aris/traces/paper-claim-audit/<date>_run<NN>/",
  "thread_id":        "<native subagent or Codex thread ID>",
  "reviewer_model":   "<resolved — the model that actually ran (target: $REVIEWER_MODEL)>",
  "reviewer_reasoning": "<resolved — the effort that actually ran (target: the configured deep effort)>",
  "generated_at":     "<UTC ISO-8601>",
  "details": {
    "total_claims":   <int>,
    "mismatches":     [ ... per-claim issue records ... ],
    "result_files":   [ ... raw files consulted ... ],
    "method_checks":  [ ... applicable method claims and their evidence locators ... ]
  }
}
```

### `audited_input_hashes` scope

Hash the **declared input set** passed into this invocation. Include the
manuscript, raw results and, for method checks, the run records, resolved
configs and versioned source files supplied to the reviewer. A change to
any of these files makes the audit stale.

**Path convention:** keys are paths relative to the paper directory for in-paper
files (`main.tex`, not `paper/main.tex`) and absolute paths for files outside it,
such as an external `results/` directory.

### Verdict decision table

| Input state                                           | Verdict          | `reason_code` example |
|-------------------------------------------------------|------------------|-----------------------|
| No quantitative or applicable method claims           | `NOT_APPLICABLE` | `no_auditable_claims` |
| Numeric claims detected, no raw result files found    | `BLOCKED`        | `no_raw_evidence`     |
| Pivotal method claim lacks evidence tying it to the executed code | `BLOCKED` | `missing_run_provenance` |
| Quantitative and applicable method claims verified    | `PASS`           | `claims_verified`     |
| Minor rounding drift only, no material mismatch       | `WARN`           | `rounding_drift`      |
| Any demonstrated material mismatch, including the executed method | `FAIL` | `claim_mismatch` |
| Reviewer invocation failed (network / malformed)      | `ERROR`          | `reviewer_error`      |

### Thread independence

Every audit starts a fresh native subagent or external Codex thread. Do not accept prior audit outputs (PROOF_AUDIT, CITATION_AUDIT,
EXPERIMENT_LOG, AUTO_REVIEW summaries) as input to this audit — the fresh
thread preserves reviewer independence per
`shared-references/reviewer-independence.md`.

### Human-readable sibling

`paper/PAPER_CLAIM_AUDIT.md` is written alongside the JSON for readers.
The JSON is the machine-readable record; the Markdown is for humans. This skill
never blocks; the user or the controlling workflow decides what a verdict means
for submission.
