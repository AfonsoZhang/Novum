---
name: research-review
description: Get a deep critical review of research from a fresh host subagent or optional external Codex. Use when user says "review my research", "help me review", "get external review", or wants critical feedback on research ideas, papers, or experimental results.
argument-hint: "[topic-or-scope]"
allowed-tools: Agent, Bash(*), Read, Grep, Glob, Write, Edit, mcp__codex__codex, mcp__codex__codex-reply
---

# Research Review

Apply the shared [working-language policy](../shared-references/research-autonomy.md#working-language) to internal work and user reports.

For structure or evidence requirements, use [paper-type-routing.md](../shared-references/paper-type-routing.md). Reuse the contribution type, stage and venue from existing materials; select only claim-relevant checks. This selects guidance within the current task and does not start another phase.

Include the [claim-preservation policy](../shared-references/claim-preservation.md) in substantive review briefs (readable path or text). For requested revision rounds, retain the reference/current claim, evidence-linked corrections and resolved/open concerns in the existing brief. Review remains optional and user-requested; this integration does not start a model call or an automatic revision loop.

## Reviewer selection

Use [reviewer routing](../shared-references/reviewer-routing.md) for fresh local
subagents and optional external Codex. Keep first-round assessments independent.
When you are the assigned reviewer, inspect the supplied materials directly
and return your findings to the caller.
For a full review of a project with a paper, use [split review](../shared-references/split-review.md)
for the separate research-materials and manuscript-only briefs.

## Workflow

### Step 1: Gather Research Context
Prepare the scope and primary artifact paths for the selected reviewer:
1. Read project narrative documents (e.g., STORY.md, README.md, paper drafts)
2. Read any memory/notes files for key findings and experiment history
3. Identify: contribution type(s), current stage, target venue/track if any, core
   claims, evidence, key results and known weaknesses. Carry the selected
   paper-type profile and its claim-specific obligations into the brief, as a
   readable path or text; do not classify every project with code as tooling.

### Step 2: Initial Review (Round 1)
Send a detailed prompt at the configured deep-audit effort, using the selected backend. For
the `codex` backend, keep the MCP payload short: write the full briefing to
`RESEARCH_REVIEW_REQUEST.md`, then point Codex at that file.

*For codex backend:*

```
mcp__codex__codex:
  model: $REVIEWER_MODEL
  config: {"model_reasoning_effort": "$REVIEWER_EFFORT_DEEP"}
  prompt: |
    Read the review brief at <absolute path to RESEARCH_REVIEW_REQUEST.md>.
    Read the referenced primary artifacts and supply a locator for each finding.
    Evaluate the stated question and contribution using the requested venue/track
    when one is specified. Verify both supported claims and alleged weaknesses
    against the artifacts. Apply the paper-type route and claim-preservation
    policy in the brief. Use only checks justified by a claim or verified venue rule. Identify:
    1. Specific logical gaps or unsupported assertions, with evidence locators
    2. Experiments necessary for the current claim, separated from optional extensions
    3. Narrative problems, including unnecessary weakening of supported contributions
    4. Whether the remaining contribution answers a useful question; explain any
       venue-specific concern rather than imposing an unspecified top-venue standard

    === SCOPE AND APPLICABILITY ===
    For a paper, idea or result: assess its actual contribution and evidence.
    Do not assume it is a research-workflow tool, impose a method-paper template,
    invent a threat model, or exclude security/formal mechanisms by default.
    For an explicitly requested local workflow-tool/code audit: use the project's
    documented operating assumptions and engineering constraints. Do not propose
    infrastructure or speculative hardening without a demonstrated defect,
    invariant or authorized requirement. Scope limits do not hide real defects.
    In either case, identify the claim/rule affected by each finding and separate
    necessary corrections from optional extensions. Do not manufacture issues.

    Say plainly when something is correct.
    Be brutally honest. If, after genuinely trying to break it, the work
    holds up and is ready, say so clearly.
```

The review brief should contain the full research context, the specific
questions, and primary artifact paths the reviewer should inspect. Keep the executor’s conclusions and prior verdicts out of the first-round brief.

For native review, give the fresh subagent the same question and primary artifact scope.

### Step 3: Iterative Dialogue (Rounds 2-N)
Continue with the same reviewer for a scoped follow-up. For native review, address the returned subagent ID. For external Codex, use `codex-reply` with its saved `threadId`. Supply the disputed claim, source location and revised artifact. Start another independent assessment only when the evidence or requested scope warrants it.

For each round:
1. **Respond** to criticisms with evidence/counterarguments
2. **Ask targeted follow-ups** on the most actionable points
3. **Request specific deliverables** within the authorized scope: evidence-linked corrections, justified claim changes and remaining contribution; experimental designs or new outlines only when requested. Retain resolved concerns so the same limitation does not cause repeated weakening.

Key follow-up patterns:
- "If we reframe X as Y, does that change your assessment?"
- "What's the minimum experiment to satisfy concern Z?"
- "Please design the minimal additional experiment package (highest acceptance lift per GPU week)"
- "Please write a mock NeurIPS/ICML review with scores"
- "Give me a results-to-claims matrix for possible experimental outcomes"

### Step 4: Convergence
Stop iterating when:
- Both sides agree on the core claims and their evidence requirements
- A concrete experiment plan is established
- The narrative structure is settled

Agreement alone does not establish value or correctness. Before treating a materially
narrowed story as settled, verify that the remaining contribution still answers a
useful question. If not, state the unresolved contribution and applicable options
under the shared policy; do not keep shrinking merely to obtain reviewer agreement.

### Step 5: Document Everything
Save the full interaction and conclusions to a review document in the project root:
- Round-by-round summary of criticisms and responses
- Evidence-supported claims, narrative, remaining value, and any authorized experiments; distinguish consensus from evidence and preserve reasons for substantive claim changes
- Claims matrix (what claims are allowed under each possible outcome)
- Prioritized TODO list with estimated compute costs
- Paper outline if discussed

Update project memory/notes with key review conclusions.

## Key Rules

- Record the actual route, model when known, thread ID and primary sources. Apply the configured effort on external Codex calls.

- Be honest about weaknesses — hiding them leads to worse feedback
- Push back on criticisms you disagree with, but accept valid ones
- Focus on ACTIONABLE feedback — "what experiment would fix this?"
- Document the threadId for potential future resumption
- The review document should be self-contained (readable without the conversation)

## Prompt Templates

### For initial review:
"Review the stated research question and contribution against the supplied evidence and requested venue/track. Apply the claim-preservation policy: justify necessary corrections, retain supported significance and separate optional extensions."

### For experiment design:
"Please design the minimal additional experiment package that gives the highest acceptance lift per GPU week. Our compute: [describe]. Be very specific about configurations."

### For paper structure:
"Please turn this into a concrete paper outline with section-by-section claims and figure plan."

### For claims matrix:
"Please give me a results-to-claims matrix: what claim is allowed under each possible outcome of experiments X and Y?"

### For mock review:
"Please write a mock NeurIPS review with: Summary, Strengths, Weaknesses, Questions for Authors, Score, Confidence, and What Would Move Toward Accept."

## Review Tracing

Save each review or failed attempt using [review tracing](../shared-references/review-tracing.md).
Report same-family and unknown-family reviews accurately. A request for a verified cross-family verdict remains open if model identity cannot establish it.
