# Controller Workflow and Stage Boundaries

## 1. Initialize & Preflight

```bash
$GATE init --root . --goal "<research objective>"
$GATE preflight --root .
```

If a workspace already exists, skip `init` and start directly with `$GATE continue --root .` or `$GATE status --root .`.

## 2. Execution Loop (Host Agent + Specialist Skills)

1. Run `$GATE continue --root .` to inspect the first unpassed, stale, or unapproved stage.
2. If `action === "await_approval"`:
   - Present the [topic-approval report](../../shared-references/topic-selection-policy.md#human-approval-after-topic-selection) or protocol freeze summary in the [report language](../../shared-references/research-autonomy.md#working-language). Use the project's `reportLanguage` preference when set.
   - **Stop and wait.** Never run `approve` without the user's explicit reply.
   - Keep the approvalVersion from the gate you present. After the user approves that version, supply it in the command:
     `$GATE approve --stage <topic|plan> --root . --version "<presented-version>" --by user --response "<user reply>"`
3. If `action === "work_stage"` or `action === "fix_gate"`:
   - Read `requiredArtifacts` for the files the gate will check. Use existing work where it satisfies the current stage.
   - Describe the contribution in the topic proposal. An optional `paperType` can use a preset or a free-text label. Choose skills by the claims and evidence under the [paper-type routing policy](../../shared-references/paper-type-routing.md). An empty `recommendedSkills` list means the host can do the work directly.
   - During planning, `suggestedEvidence` provides examples. In `research/protocol.md`, put additional files needed for the claims in the `Stage` / `Required artifact` table. For a proof-only method, an `experiment` row can name `research/proofs.md`. For a mixed paper, add a `plan` row naming `research/planned-runs.json` if the approved work includes new runs. That commitment also requires `research/observed-runs.json` at execution. A screening ledger declared for `experiment` at `research/source-selection.json` is checked independently. Existing measurements may be cited directly.
   - Before drafting the synthesis or protocol, check `retrievalIntents`. Each key names a purpose. Its values are alternative ledger intents for that purpose. Reuse relevant registered searches and run a search for each uncovered purpose. Record an actual zero-result search as `attempted`. For a target venue, an explicit venue gap can document unavailable guidance.
   - Register queries with `$GATE retrieval ...` and retrieved sources with `$GATE source ...`. Cite the relevant `RET-*` IDs directly in the synthesis or protocol.
   - At `review`, follow `reviewInstruction` and the [research-review skill](../../research-review/SKILL.md). Use the configured independent reviewer route. A pending review stays open until its reply arrives. Record the reviewer's returned verdict and summary in `research/review.md`. When resuming, reuse a review that covers the current materials.
   - For a stale gate, assess how the changed inputs affect the existing work. Update any affected claims or artifacts. Existing work can pass again as written when the evidence still supports it.
   - Run `$GATE gate <stage> --root .`.
4. If `action === "completed"`:
   - Deliver the final summary in the report language and list pending outward-facing actions (submission, release, push) for the user.

## 3. Rework / Backtracking

Use rework when the host has verified an upstream flaw against the evidence, such as a reported result computed with the wrong protocol. Check whether existing results support a correction or narrower claim before adding an experiment.

```bash
$GATE rework --target <plan|experiment|analysis|writing> --root . --reason "<concrete diagnosis>"
```

- Rework is capped by `maxRevisions` (default `3`).
- `topic` cannot be targeted by automatic `rework`; topic replacement requires explicit user direction.
- The controller records hashes of the stage artifacts, referenced evidence, and validator inputs. Repair the file implicated by the diagnosis. For example, a corrected run record can satisfy experiment rework while the execution summary stays accurate. The host assesses whether the correction resolves the reason for rework. When resuming an older active rework, `continue` retains its original primary hash and captures supporting files before the next repair.

## 4. Stage Boundary & Context Reconstruction (cdtspec pattern)

Every time `$GATE gate <stage> --root .` passes, it returns a `boundaryClosure` object:

- All stage state, artifact hashes, and closed gaps are persisted on disk.
- Report the closed stage boundary to the user.
- Context may be safely reset (`/clear`) at any stage boundary; running `$GATE continue --root .` reconstructs the exact project state, passed stages, registered sources, and next stage without relying on lossy conversation compaction.
