# Standalone research runtime

The TypeScript runtime owns model/tool turns, persistent sessions, task dispatch,
evidence gates, independent review and stage transitions. It does not call Codex,
Claude Code, pi or dsh. Existing specialist skills remain usable in their original
hosts; this is an additional executable entrypoint.

## Start

Requirements: Linux, Node.js 22+, npm, Python 3 for existing research validators,
and Bubblewrap (`bwrap`) when local command execution is enabled.

```bash
npm ci
npm run build
cp config/runtime.example.json /path/to/project/runtime.json
# Edit endpoint/model/family values and export the named credentials in your shell.
node dist/src/cli.js init --record /path/to/project/project.json \
  --config /path/to/project/runtime.json --goal "Your research objective"
node dist/src/cli.js doctor --record /path/to/project/project.json
node dist/src/cli.js pipeline --record /path/to/project/project.json
node dist/src/cli.js run --record /path/to/project/project.json
```

`baseUrl` is the base of a Chat Completions compatible HTTP endpoint, before
`/chat/completions`. Both routes must support the message format; the executor
also needs function calling. The `reviewer` route is optional: omit it to reuse
the executor's endpoint, model and credential environment variable in a fresh
review session. An explicitly configured reviewer can also use the same model
or family. Configure a different family when cross-family review is available;
there is no automatic fallback on a configured reviewer's request failure.
Supply accurate model-family identifiers. Review results and Trace events record
`same_family` or `cross_family` based on those labels, not verified provider
provenance. Same-family review includes a persisted independence limitation,
visible in the dashboard; evidence and acceptance gates remain mandatory.
Secrets live in environment variables,
never in the project record. No production model endpoint is bundled or selected.
`doctor` reports credential presence and local capability configuration; it does
not claim an untested network or model connection works. Pass `--probe` to run a
read-only `GET /models` provider capability preflight (checking credential rejection,
model listing, context/output limits, and tool/reasoning support without calling
`/chat/completions`).

New standalone runtime projects default to `automatic`, allowing the standard
pipeline without a `--mode` flag. `--mode on_demand` permits one scoped task;
`--mode autopilot` remains available. Existing project modes are preserved.
Initialization and seed reordering do not themselves execute research; use
`pipeline` to register the stages and `run` to execute them. The mandatory human
checkpoint after topic selection applies in every mode. This runtime default
does not change the opt-in automatic-mode rules for standalone skill sessions.
Optionally select the contribution with `paperType` in research inputs or the dashboard.
New projects default to `null` (unselected). The accepted topic review supplies a
type and its rationale before the runtime routes downstream stages.
Older records without it inherit `researchKind`: `theory` and `survey` map to
the same paper types; `empirical` maps to `method`. Reading an older record does
not migrate it. Empirical routes impose planned/observed experiment records.
Add a custom task with `task --file task.json` for a narrower endpoint or an
independent parallel branch. IDs are unique and dependencies must already exist.

The workflow retains coarse stage categories for compatibility, but each paper
type builds a different task graph with enforced dependencies and review back edges:

| Type | Investigation nodes between the common topic/literature and writing/review/delivery nodes |
| --- | --- |
| Method | Protocol → implementation → comparisons → mechanism/attribution check → analysis |
| System | Design → implementation → workloads → reliability/resource check → trade-off analysis |
| Benchmark | Measurement protocol → construction → quality/leakage gate → evaluation → validity analysis |
| Empirical | Study design → sampling/control gate → study → sensitivity/alternative explanations → analysis |
| Replication | Original protocol → implementation alignment → reproduction → deviation audit → analysis |
| Theory | Definitions → parallel proof construction and counterexample search → proof audit → conclusions |
| Survey | Search protocol → search → screening → extraction → synthesis → coverage audit |
| Position | Argument plan → grounded premises → serious objections → argument revision → scope analysis |

The unresolved-type workflow runs topic selection first; downstream placeholders
stay blocked until topic review resolves the type and the user approves the topic.
Type-specific nodes are then registered atomically. Common stage IDs such as
`experiment` remain stable storage identifiers; the dashboard displays the actual
node label (for example, proof construction or source screening).

Checkpoint reviews must return `transition: {action, reason, target?}`. Accepting
verdicts require `advance`; failed/blocked reviews may `revise` only to a declared
ancestor or `stop` for missing resources/evidence. Invalid or missing transitions
are review errors. The executor cannot invoke a transition tool or approve a topic.
The scheduler applies a revision only after affected workers exit and calls are
known to have finished. It records the previous reviews/artifact hashes, reopens
the repair node and its dependent pipeline nodes, and requires changed repair
artifacts plus fresh downstream acceptance. Independent branches retain their
valid acceptance; custom dependents become stale and require explicit retry.
Topic selection is never an automatic revision target. Changed scope invalidates
pending decisions. HTTP/provider errors do not cause workflow rewinds.

`maxWorkflowRevisions` limits automatic back-edge traversals per project (default
3, zero disables them). Request/time budgets also apply and never reset during
revision. Exhaustion stops the workflow with an explicit reason; `resource` can
raise this limit with the user's recorded authorization. These are resource stops,
not scientific acceptance criteria. Trace records requested/applied revisions,
reopened nodes, cancellations and stops. The dashboard shows actual prerequisites
and allowed return paths.

Coupled nodes reuse `main`; independent tasks with distinct `session` and
non-overlapping `writes` can run concurrently.
Workers load the declared skill instructions, but **instructions cannot advance
the state machine**. Automatic mode does not give a model an approval tool.

User-facing reports default to Chinese. Set `"reportLanguage": "English"` (or another language) in the runtime config at initialization for a project preference. A language requested for a particular report takes precedence. With no preference, the agent can adapt to a specified audience.

After topic selection, read the saved comparison with the closest paper or open-source system and the evidence that could overturn the proposed distinction. Record the actual user
decision using the exact current version:

```bash
node dist/src/cli.js approve-topic --record /path/to/project/project.json \
  --version 1 --response "The user's explicit approval of this proposal"
node dist/src/cli.js run --record /path/to/project/project.json
```

Only an explicit CLI user action approves the version. An agent's prose, expired
timer, existing approval for an older topic or reviewer verdict cannot do so.
Commands run inside Bubblewrap, with the filesystem read-only except assigned
outputs, hidden home directories, a private temporary directory and no network.
Command credentials are not inherited. Set `allowCommands: true` explicitly when
the project should run experiments. Sandbox startup failure is a task error;
there is no unsandboxed fallback. Fetching text sources is a separate runtime tool.

## Enforced transitions

| Condition | Runtime action |
|---|---|
| Task becomes ready | Check topic version, accepted dependencies, write/read conflicts, session ownership and resource limits; reserve a unique lease before dispatch. |
| Non-topic task starts | Run an adversarial literature query automatically and preserve retrieved evidence. A successful empty search is recorded, not invented into evidence. |
| Executor returns text without tool calls | Treat it as a request to validate; check nonempty artifacts and unchanged inputs. |
| Claims/citations are present | Require registered snapshots, stable IDs, evidence locations and literal passage membership; check Markdown URL and LaTeX citation-key membership. |
| Applicable deterministic checks | Invoke the existing run-record checker, LaTeX integrity precheck and plotting-source validator; persist input hashes and reports. Missing helpers fail closed. Unchanged successful checks are reused. |
| Mechanical checks pass | Invoke review in a fresh session, including when using the same model; send original inputs, outputs, retrieved evidence, checks and open challenges. Record configured family independence. Reuse an unchanged review only with the same reviewer route and independence. |
| Major/critical challenge is open | Keep acceptance blocked. Executor responses cannot resolve it; the independent reviewer must inspect evidence and explicitly resolve the stable ID. Minor limitations remain visible. |
| Review passes | Recheck hashes and evidence, then accept the task. Topic tasks instead leave downstream work waiting for explicit topic approval. |
| Inputs or evidence change | Mark accepted work stale and propagate invalidation through dependent tasks before dispatch. |
| Delivery | Rehash `PAPER_CLAIM_AUDIT.json` inputs, including the run records, configs and versioned code used for applicable method checks. Preserve distinct PASS/WARN/FAIL/NOT_APPLICABLE/BLOCKED/ERROR states. |
| Budget/no-progress stop | Save an inconclusive outcome and open issues. Execution completion is separately visible as `executionCompletedAt`; it does not confer acceptance. |

The independent reviewer judges support and scientific validity. Deterministic
membership checks cannot establish those facts. The runtime guarantees that the
required checks are invoked and respected, not that a model's scientific judgment
is infallible. No minimum number of review rounds, sources or domains is imposed.

## State, recovery and control

### Local dashboard

```bash
# Start the real Web workspace and open a browser.
npm run web

# Connect an existing project; CLI and Web use the same runtime and record.
npm run web -- --record /path/to/project/project.json

# Print the URL without opening a browser (also the default over SSH).
npm run web -- --no-open
```

The underlying command is `research-loop web` (or `node dist/src/cli.js web`).
It opens the printed URL, normally `http://127.0.0.1:4317`. If that port is busy,
it tries ports through 4327; an explicit `--port` disables fallback. Browser-open
failure leaves the server running and prints its URL for manual use.

Model APIs are deployed and configured on the backend. For new projects, the
server reads `config/runtime.local.json` by default; `--config /path/to/runtime.json`
takes precedence over `RESEARCH_RUNTIME_CONFIG` and that default. Use the same
format as `config/runtime.example.json` and export the named API key environment
variables before starting Web. The local config file is ignored by Git. The page
shows backend configuration status without exposing API URLs, environment names
or keys, and its API rejects browser-supplied routes, credentials or resource limits.
Concurrency, request/time budgets and automatic-revision limits are backend-only.
The workspace and dashboard snapshots omit those settings; configure new-project
defaults in the backend runtime file and update existing project budgets through
the CLI `resource` command while preserving the user-authorized ceilings. Existing
projects keep the routes in their backend project record; the new-project config
does not silently replace them. Edit model configuration on the backend while
research is stopped.

Web opens directly on the dashboard, including when no project is selected. The
**打开已有项目** and **创建项目** buttons sit together in a compact project toolbar.
On Windows and WSL, **创建项目** opens the native File Explorer folder selector
directly. For **创建项目**, select the parent folder, then enter a project name
in the dashboard and confirm **创建并打开**. Only confirmation creates a new child
folder containing an empty `project.json`; cancelling either step writes nothing.
Existing folders are never reused or overwritten by this flow. Use **打开已有项目**
to connect an existing folder. Creating a project does not scan existing materials
or start research.

The folder selector is a native Windows GUI executable, built from
`src/native-folder-picker.cs` during `npm run build` on Windows/WSL using the
Windows .NET Framework compiler. Button clicks do not launch PowerShell or a
console host. Private temporary files carry results and cancellation across WSL;
the dialog closes on cancellation or after five minutes. A transparent GUI owner
and a one-time dialog activation bring it to the foreground without leaving it
always on top. To exercise the actual Windows windows and cancellation, run
`RESEARCH_NATIVE_UI_TEST=1 node --test dist/tests/runtime/native-picker.test.js`
after building (this test briefly opens both selectors). A build on another OS
can run the web service but does not provide the Windows picker.

**打开已有项目** also uses the native folder selector. Existing runtime records are
restored without initialization writes. An ordinary code or research folder is
initialized in a detached worker, with durable stages for file scanning, document
reading, grounded input extraction, AGENTS.md supplementation and record saving.
The dashboard shows stages, actual elapsed time, document names and field sources.

Initialization reads a bounded set of local text documentation. Hidden files,
credentials, dependency/build/data directories, symlinks and Git-ignored files are
excluded. It never executes project scripts. The configured model may extract
research seeds, but each accepted title and quote must occur in its source file;
paper type and target venue require explicit labelled declarations. Conflicting
commitments stay blank. New projects created with **创建项目** stay empty and do not
run this import flow.

Progress and partial findings survive browser closure and service restarts.
Interrupted or failed initialization offers **重试初始化**; completed unchanged
sources can be reused. Input fields edited by the user, including explicit clears,
are protected from automatic updates. Open editor drafts are retained, and saves
merge untouched fields with concurrent initialization updates. Competing user
edits still produce conflicts. No research tasks or scheduler are started by init.

If AGENTS.md is absent, initialization creates it. Otherwise it appends a labelled
orientation block once and preserves all existing content. Later retries never
replace human edits, including edits inside the generated block. Unknown metadata
remains available for manual entry through research seeds, paper type and venue.

Creation defaults to automatic mode and leaves paper type unselected. Research
scope is supplied through paper seeds: a direction, an engineering problem, or a
reference paper. There is no separate research-question field. Use **一键启动** after
saving those inputs. Explicit JSON-record opening rejects missing records; folder opening initializes
missing records. Creating rejects existing files. Neither action dispatches research.
The dashboard shows empty states until a real project is selected. Switching
projects changes the service's selected record for all its tabs; stale-tab writes
are rejected. Use separate Web servers to keep projects open independently.

Schedulers and workers inherit backend credentials from the service environment;
records store environment-variable names, not key values. A separate CLI process
needs its own credential environment. Project setting edits are blocked while a
scheduler or worker is active. Existing explicit goals remain valid. For projects
with an empty goal, startup, dispatch, executor context and independent review use
the ordered research seeds. This is a read-time fallback, not a duplicated stored
goal, so editing or removing seeds cannot leave an obsolete copied objective.
With neither a goal nor seeds, launch and dispatch remain blocked. A venue or
paper type alone does not supply research scope. Legacy goal edits retain optimistic
revision checks and are rejected after the first task attempt.
Existing records and unrelated tracker fields are preserved.

The original `dashboard --record ...` command remains available for a fixed
project without browser auto-open or workspace setup. The dashboard receives live snapshots via
server-sent events (`/api/stream`): record changes trigger a debounced push and a
one-second check updates heartbeats and process liveness. Reconnection receives
the latest complete snapshot; visible tabs fall back to two-second polling while
the stream is unavailable. Missing or damaged records recover without restarting
the dashboard. Four task lanes
distinguish waiting, running, attention needed and accepted work. A completed
execution with a blocked scientific review remains in the attention lane.

Click **一键启动** below research inputs to start the project. For a new automatic
project, this atomically creates the workflow graph and launches a detached
scheduler. Existing tasks retain their scope; an empty on-demand project requires
a scoped task first. Save input edits before starting. Missing model credentials,
skills, inputs or available budget appear beside the button before launch.
Use `web --skills /path/to/skills` (or `dashboard --skills ...`) when the packaged
project skills are not the intended source.

The scheduler survives closing a browser tab or stopping the dashboard server.
Concurrent clicks and CLI `run` share a persisted process identity and launch
reservation, preventing duplicate scheduler starts. Worker dispatch remains
transactional. Events record requested, started, stopped and failed runs, and
`.research-loop/logs/scheduler.log` records background output. A dead scheduler
can be resumed with **继续启动** when runnable work remains; uncertain or failed
tasks still need the existing diagnosis/reconciliation path.
Project updates queue in arrival order within each process and retain the shared
file lock across processes. Unchanged transactions do not rewrite the JSON file.
Worker heartbeats normally persist every two seconds (faster for explicitly short
heartbeat timeouts), and scheduler heartbeat writes are throttled to two seconds.
Scheduler lock-acquisition contention receives up to two additional attempts with
backoff after the existing acquisition retries; disk and permission errors still
fail immediately. This recovery does not retry failed research or model calls.
Use **暂停** to stop new task dispatches while active tasks finish, and **继续**
to resume. The persisted pause applies to dashboard, CLI `run`, and CLI `tick`,
including after a server restart. The page distinguishes draining from fully
paused work. Continue still respects topic approval, credentials and budgets.
Use **终止** to cancel active and queued tasks and their local child processes.
Cancellation is cooperative at worker heartbeats; completed artifacts and Trace
remain available. An already dispatched remote request may still be billed.
Termination stays in effect until an explicit CLI `retry` with a diagnosis (and
reconciliation for uncertain calls) reopens execution after workers have exited.
It does not automatically replay cancelled tasks. Controls are versioned against
the current project/run, and all actions appear in the event log and Trace.
Scheduling stops at human/resource gates or when no further work can run.
The button does not approve a topic, retry failed work or increase budgets.
After explicit CLI topic approval, click again to continue.

The stage strip and search field filter tasks, evidence and recent events. Select
a task to inspect dependencies, output paths, independent review, deterministic
checks and unresolved challenges. Registered text artifacts and evidence snapshots
can be previewed as inert text, capped at 256 KiB. The event view shows the newest
250 events; the complete log remains available through the CLI. The overview
focuses on research progress, without resource-budget controls or capacity meters.
Subagent and Trace details retain actual model/tool counts, provider-reported
tokens and elapsed time. Missing workers and stale accepted artifacts are shown
without changing the project record.

The **Workflow** panel shows separate executed/accepted counts, active stages and
the current operation (retrieval, model request, tool, deterministic check or
independent review). Waiting tasks explain topic approval, upstream acceptance,
missing files, resource limits, concurrency or overlapping work. Ready tasks are
eligible for dispatch; this does not mean a scheduler is running. Start `run`
separately to execute them. Progress counts registered tasks, not estimated
scientific completeness or elapsed-time percentages.

The **Subagent calls** tab (`/#agents`) presents the actual invocation hierarchy:
task scheduling → executor worker attempt → independent reviewer session.
Reviewers have fresh context and run inside the worker process; they are not
additional OS workers. Each entry includes its task, attempt, session, model,
status, current operation, elapsed time, model/tool counts, reported tokens and
a link to the attempt's Trace. Live workers show PID and heartbeat health;
reviewers inherit their host worker's liveness. Local command processes are
counted separately. Failed, uncertain and interrupted calls retain their history;
queued retries do not reopen earlier invocations. No recursive agent-spawning
facility is implied by this view.

Large tool results are kept on disk with explicit previews and continuation paths,
following the bounded-output pattern used by [Pi](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/tools/truncate.ts).
The runtime limits inline tool results to 50 KiB. `fetch_source` retains the original
source snapshot and supplies a separate HTML-to-text reading aid; `read_file` returns
up to 16 KiB per page, with zero-based UTF-8 byte offsets, `nextOffset`, and optional
literal `query` search. A preview is not complete evidence. Oversized historical
tool messages are projected at request time while original messages remain intact;
Trace records the actual projected input. These byte limits do not increase a
provider's token context limit. HTTP failures now retain bounded, credential-redacted
provider diagnostics, including error message, code, parameter and request ID when available.
Independent review uses the same bounded evidence previews and can page or search
the supplied originals through a read-only `read_file` tool. That tool is restricted
to the review package and its preserved reading aids; input hashes are checked again
before accepting a verdict. Unread evidence is not established by a preview.

The **Execution Trace** tab (`/#trace`) shows the recorded sequence of model calls,
tool calls, retrieval, deterministic checks, independent review and task lifecycle
events. Open it from a task's detail dialog to select that task. Filter by task,
execution attempt or step category; expand a step for recorded model messages and
responses, tool arguments/results, errors or validation feedback. Durations and
provider-reported token counts appear when recorded. Trace browsing is read-only
and does not call a model or execute a tool.

The trace loads the latest 80 matching events initially and can page backward
through the full event history. Search applies to loaded step summaries. New
events appear with live snapshot updates; expanded details stay open, and heartbeat
updates do not replace the page or discard research-input drafts.
New model events record task/attempt and message-array boundaries. Older events
are attributed using request IDs and event-time session ownership where possible;
when historical message boundaries are absent, the UI says that input/output
cannot be reconstructed rather than substituting the current session. Details
are inert text, limited to 32 KiB per section and the latest 100 input messages.
Configured credential values and common credential fields are redacted.

The research-input editor manages research seeds and the target journal in the
canonical project record, with validation and optimistic revision checks. All
other execution controls (cancel, retry and topic approval) remain
in the CLI. The start endpoint is `POST /api/run` with a JSON body containing
`expectedRevision` and `topicVersion` and the `X-Research-Control: 1` header;
stale input/topic versions are rejected. In workspace mode, mutation requests also
require `X-Research-Workspace` with the URL-encoded absolute selected record path.
The server binds only to loopback and has no generic file server. Model routes
and credentials are managed only on the backend and are not returned by the
workspace settings API. Model message
slices are available only through the requested trace step detail.
All views use the connected project record. New projects have no tasks, seeds,
evidence or invocation history; missing records show setup or an unavailable
state. Seed edits are persisted to the project. The research-input template is
empty until the user supplies inputs. Press
Ctrl+C in the dashboard terminal to stop only the dashboard, leaving research
workers untouched. Both client and server are TypeScript; `npm run build` builds
the dashboard with the runtime, without extra frontend dependencies.

<a id="seed-papers-and-target-journal"></a>

### Paper types, research seeds and target journal

Use **Select paper type** above the stage strip to optionally choose the contribution type.
This determines the standard pipeline's skills, required artifacts and applicable
checks, and supplies the corresponding criteria to the fresh reviewer. The default
is **暂不选择 · 自动判断**: explore the question without fixing a contribution type.
An accepting independent topic review must return a supported type and rationale;
missing or invalid recommendations block acceptance. The runtime records this
decision in Trace, configures queued stages and shows the resulting type and reason
on the dashboard. The user's selection remains blank. Human topic approval is still
required before downstream work. Automatic execution mode remains unchanged.

| `paperType` | Contribution | Route-specific requirements |
| --- | --- | --- |
| `null` | Unselected / automatic | Topic review must resolve the type before downstream work |
| `method` | Method / algorithm | Method template; planned and observed comparison runs |
| `system` | System / engineering | System design and trade-off reports; workload run records |
| `benchmark` | Benchmark / evaluation / resource | Benchmark template, measurement protocol and validity report; evaluation run records |
| `empirical` | Empirical analysis / negative results | Analysis design, sampling and sensitivity; complete run records |
| `replication` | Replication / reproducibility | Original-claim protocol and deviation record; reproduction run records |
| `theory` | Theory / formal analysis | Definitions/assumptions and proof/counterexample artifacts |
| `survey` | Survey / synthesis | Search protocol and validated source-selection catalog |
| `position` | Position / conceptual argument | Argument plan, source-backed premises and objections |

Survey, theory and position routes do not load experiment-only skills or require
experiment run files by default. The stage strip labels the investigation stage
as literature selection, proofs/counterexamples or evidence/objections accordingly.
Type-specific required files are declared outputs and become downstream inputs;
the artifact gate blocks their omission. Survey selection is a nonempty JSON array
of `{sourceId, decision: "include" | "exclude", reason}`. It requires unique,
registered, unchanged source snapshots and at least one included source. The
reviewer receives the selected sources' original snapshots. These structural
checks do not verify mathematical proofs, scientific coverage or other semantic
claims; those remain obligations of independent review against original evidence.

Changing type versions the inputs, invalidates old topic approval and marks
accepted work stale. Queued standard tasks adopt the new route immediately;
running attempts keep their pinned route and stop at existing revision/approval
checks. Retrying a standard task applies the new route. Exact legacy standard
templates can be recognized; custom task prompts and write scopes are preserved.
Standard pipeline registration is atomic with respect to input updates. No change
starts a model call or supplies topic approval.
Obsolete type-specific nodes remain in the record/Trace but are excluded from the
active graph and cannot dispatch. Complete legacy standard pipelines can migrate
at a scheduler checkpoint; accepted tasks with changed prerequisites become stale.
Custom workflows are preserved.

The same editor manages up to 50 research seeds and one target conference or journal.
The venue dropdown groups common conferences and journals and fills their name and
official URL. It also supports an undecided target and custom entries. Changing the
filled name or URL makes the entry custom; selecting an undecided target clears
the name, URL and venue notes. Existing custom targets remain editable.

The backend catalog lives in `config/venues.json` and is served through read-only
`GET /api/venues`. The initial catalog contains 16 conferences and 16 journals,
with stable IDs, names, abbreviations, types and official publisher/organizer links.
Conference links may lead to the organizer or series page that lists annual editions.
Catalog entries are starting points, not verified deadlines or submission rules.
The runtime still retrieves the selected page before inference and includes its
snapshot in independent review. The persisted `targetJournal` field and lookup
key are retained for compatibility and now represent either venue type.

To maintain the catalog, edit `config/venues.json` and run `npm run build`;
the build copies it to `dist/config/venues.json`. The server validates unique IDs,
unique URLs and HTTPS links. No project inputs or model budget are changed when
loading the catalog. If loading fails, the editor offers retry and custom entry.
A seed is a starting point for a paper, which may be a
reference paper, a research direction or a problem encountered in engineering.
Each seed has a stable ID, required title, optional HTTP(S) URL and notes. The
editor adapts its labels to the selected type and defaults new entries to a direction.

Seed order is priority order: the first seed is investigated first, followed by
its required counterevidence, before the next seed. Tab to a card's ordering controls
and use Arrow Up/Down or Home/End, or activate the Up/Down/First/Last buttons. Save to apply
the order. The overview displays numbered priorities; adding a seed places it last.
The executor and independent reviewer receive explicit ranks and all seed context.
Priorities do not establish scientific merit or approve the topic. Any decision to
advance a lower-ranked seed needs an evidence-based explanation.
There is no separate subject-preference selector or priority flag. The retired
`selectedDirectionId` field in older input files does not override list order.

| `kind` | Input | Required runtime lookups |
| --- | --- | --- |
| `paper` | Paper title, optional DOI/link and points to investigate | DOI or title search |
| `direction` | Research question/direction, optional ideas and scope | Related work/open problems, then limitations/counterevidence |
| `engineering_problem` | Problem summary, optional setting, symptoms, expected behavior and constraints | Failure modes/mitigations, then failed solutions/tradeoffs |

Directions and engineering problems need no bibliography. A DOI belongs to a
reference-paper entry; add a separate paper seed to connect it to an idea/problem.
User-reported symptoms are retained as reports, with causes and possible solutions
treated as hypotheses until supported by reproduction or other evidence.

A journal has a required name, optional publisher/author
guide URL and preference notes. These are user-supplied leads and preferences;
they do not establish verified bibliography, journal policy or submission consent.

The same inputs can be supplied through the CLI. Copy
[`research-inputs.example.json`](../config/research-inputs.example.json), replace
its placeholders, and use:

```bash
# Optional initial inputs, validated before project creation.
node dist/src/cli.js init --record project.json --config runtime.json \
  --goal "The research objective" --inputs research-inputs.json

# Inspect the current revision and values.
node dist/src/cli.js inputs --record project.json

# Replace the full input set using the revision returned above (0 for older records).
node dist/src/cli.js inputs --record project.json --file research-inputs.json --version 1
```

The JSON file contains `seedPapers` in priority order, `targetJournal` and optional
`paperType`. On initialization, omitted or `null` `paperType` means
unselected. During updates, omission preserves the existing selection; explicitly
send `null` to clear it. Older records that lack the field still inherit
`researchKind`, without a read-side migration. With an empty seed list, the agent
explores within the project goal. Replacements describe the complete input set. The historical
`seedPapers` name now holds all three seed types for project/file compatibility.
Use an empty array and `null` to clear them. A missing `kind` retains the original
`paper` meaning. Explicitly setting that implicit kind to `paper` is a no-op;
changing an entry's actual type creates a new input revision.
IDs contain letters, digits, underscores or hyphens. DOI URLs are normalized to
bare DOIs. Conflicting saves return HTTP 409 and retain
the editor draft, allowing the user to reopen and merge with the latest values.

Each task pins the input revision at dispatch. Before any executor model call,
the runtime executes the type-specific lookups above in saved seed order, including counterevidence
for every direction and engineering problem even at the topic stage, then retrieves
the supplied journal page. Seed search queries use the title (or a paper DOI),
with type-specific search terms. Full context notes reach the executor and fresh
reviewer for interpretation and more focused follow-up retrieval.
Without a journal URL it searches literature for journal/topic
context; that search is **not** verification of official author instructions.
Lookup receipts and source snapshots enter the independent review pack. Failed
lookups stop the task; missing receipts, including a non-paper seed's counterevidence
receipt, or changed snapshots block acceptance.
Empty search results remain visible gaps for the executor and reviewer to assess,
and do not verify a publication, research hypothesis or reported engineering cause.
Seed URLs are supplied as reference leads; this hook retrieves literature search
metadata, not seed PDFs, issue pages or full text automatically.

Saving changed inputs records a revision and its history, marks earlier accepted
tasks stale, and prevents in-flight work from being accepted against obsolete
inputs. Changing paper type or seed order (including adding or removing seeds)
also records the old topic decision and invalidates its approval; a new proposal
must be explicitly approved. Selection alone never approves a topic.
An automatic type decision is tied to the accepted topic and research-input
revision. Changed inputs or stale topic evidence invalidate it; saving the unchanged
blank choice preserves it and its rationale.
At the next loop checkpoint that work stops; use `retry` with a diagnosis
to rerun affected tasks in dependency order. A stale topic proposal cannot be
approved. A newly accepted topic still requires explicit user approval.
Unchanged saves do not invalidate anything. Saving inputs never starts research,
changes execution mode or resource budgets, or grants topic approval.

### Persistent state and CLI control

`--record` points to the existing project JSON record where possible. The runtime
adds one `agentLoop` namespace and preserves other fields. That namespace is the
canonical state, including tasks, sessions/messages, usage, claims, challenges,
sources, typed knowledge edges and ordered events. `.research-loop/` holds only
referenced evidence bytes, process logs and checker reports, not a competing ledger.
Writes use a cross-process lock, fsync and atomic replacement.

```bash
node dist/src/cli.js status --record project.json
node dist/src/cli.js events --record project.json
node dist/src/cli.js recover --record project.json
node dist/src/cli.js cancel --record project.json --task experiment
node dist/src/cli.js steer --record project.json --session main --message "Additional constraint"
node dist/src/cli.js retry --record project.json --task experiment \
  --diagnosis "Concrete changed approach after inspecting the logs"
```

`run` is a foreground scheduler. Workers survive scheduler exit and save their
results. Start `run` again to reconcile and release newly accepted dependencies;
there is no claimed OS daemon or automatic wakeup after the scheduler exits.
Process identity includes Linux boot ID and process start time, avoiding PID reuse.
A worker heartbeat, task time limit and process-tree memory sampling detect stalls.
Recovery stops orphan process groups and marks interrupted work; it never blindly
launches the same task again. Repeated no-progress validation requires a changed
diagnosis within the remaining budget.

Model/tool dispatch is recorded before IO. An ambiguous timeout or process death
leaves a pending operation. Inspect logs and artifacts, then pass
`--reconciliation "observed outcome and decision"` to `retry`. The runtime closes
unknown tool results explicitly; it never replays the effect or falls back to
another reviewer after a possibly billed request. There is no timed automatic review retry.
An unchanged evidence/response set reuses its previous review, including a failed
verdict; repeatedly saying “done” cannot obtain a new verdict by chance.
The polling timer only watches external worker/process completion.

`maxRequests` caps dispatched model requests, including review and failed attempts.
Token usage is recorded when providers return it; unknown transport outcomes are
counted separately. `maxWallSeconds` caps aggregate active task seconds, excluding
time waiting for human topic approval. `maxTaskSeconds` bounds execution time;
`maxReviewSeconds` separately bounds review time (default 900 seconds per task
attempt, cumulative across review/repair rounds). Both count toward the project
total. Review has a deadline even when invoked without a scheduler worker.
Concurrency, per-command timeout and sampled `maxMemoryMb` add local bounds. Memory sampling is not a kernel
cgroup limit. No dollar price or exact bill is inferred from missing provider data.
`resource --file limits.json --response "actual authorization"` changes explicit
limits; it cannot grant topic approval or silently restart a stopped branch.

`maxReviewInputBytes` caps the entire initial review evidence package (default
65536 bytes), in addition to the general context limit. Large source bodies and
indexes become explicit file references. The reviewer can page through the
originals using scoped read-only tools; omitted text is never treated as verified.

After an infrastructure error in review, `retry --review-only --task ID
--diagnosis "concrete diagnosis"` queues a fresh review of completed work. It
requires unchanged artifact/evidence hashes and no pending executor steering;
uncertain calls still require explicit reconciliation. The runtime rechecks
inputs and evidence, preserves the report, and skips executor/retrieval calls.
This does not retry a substantive rejected verdict or bypass topic approval.
If review finds work that requires artifact changes, this scoped retry stops.

`maxParallel` defaults to **4 concurrent task workers**. Set a positive integer in
the runtime config to match API capacity and local resources. Independent review
runs within its task worker and does not consume an additional worker slot.
Dependencies, shared sessions and conflicting file scopes still constrain dispatch.
Existing projects retain their saved limit; to change one, put
`{"maxParallel": 4}` in `limits.json` and run:

```bash
node dist/src/cli.js resource --record project.json --file limits.json --response "Set worker concurrency to 4"
```

## Evidence, knowledge and delivery

Built-in tools include scoped file IO, sandboxed argv execution, OpenAlex search,
text-source retrieval, local evidence snapshots, claim/citation registration,
challenge responses and typed knowledge edges. Binary PDFs need local text
extraction before `snapshot_file`; visual model inspection is not implemented.
Source identity, version, retrieval time and content hash stay with the snapshot.
Register a manuscript citation key with `register_citation` after retrieval.

```bash
node dist/src/cli.js validate --record project.json
node dist/src/cli.js audit --file PAPER_CLAIM_AUDIT.json
node dist/src/cli.js pack --record project.json --output delivery.json
node dist/src/cli.js replay --file delivery.json
node dist/src/cli.js import-knowledge --record another-project.json --file delivery.json
node dist/src/cli.js knowledge --record another-project.json --query "counterevidence"
```

The portable bundle contains the project record, evidence, available declared
artifacts, validator reports, available lockfiles and environment metadata.
Missing runs and incomplete acceptance remain visible. Offline replay checks
bundle hashes and event ordering; it does not claim to recreate model reasoning
or reinstall an entire research environment. Knowledge import reuses evidence,
claims and edges without importing task acceptance, topic approval or budgets.

## Design references and scope decisions

Sources inspected on 2026-11-02:

- [pi agent-loop source](https://github.com/badlogic/pi-mono/blob/main/packages/agent/src/agent-loop.ts): model/tool turns, queued input and explicit continuation boundaries.
- [dsh agent-loop contract](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/README.md) and [architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md): typed service boundaries and durable session effects.
- Local `codex exec --help` and `codex exec resume --help`: persisted session identity and machine-readable lifecycle events. No Codex execution dependency was introduced.
- The local conductor-research domain implementation: stable claims/challenges and mechanical evidence gates. Its fixed round/source/domain quotas were intentionally not adopted.

The former TODO candidates are covered by the local runtime primitives above.
The optional host-review fallback is superseded by direct HTTP model calls with
no ambiguous retry. A local dashboard and seed-paper/target-journal editing were
subsequently authorized on 2026-11-02. One-click scheduler launch was added on
2026-11-03; interactive review, task repair and budget changes remain CLI actions.
There is no cloud deployment, cluster/SSH orchestration,
multi-machine scheduler, full plugin framework or second research database.

## Verification

```bash
npm test
python3 -m unittest discover -s tests -v
```

Runtime tests include real detached worker processes, actual filesystem locks,
sandbox isolation and a local HTTP model/search fixture that completes all eight
pipeline stages with an explicit topic checkpoint. These are infrastructure
fixtures, not scientific findings or a validation of any live model provider.
