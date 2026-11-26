# Changelog

All notable changes to **Novum** (formerly Auto-Research System) are documented in this file.
Versioning follows [Semantic Versioning](https://semver.org/).

## [v1.5.0] — Unreleased (`release/v1.5.0`)

### Highlights
- **Skill Family Consolidation (38 → 17 Core Skills)**: Reorganized 38 overlapping skills into 17 orthogonal, low-redundancy core skills with zero capability or script loss. High-value sub-skills remain editable on demand under each parent skill's `modules/` directory.
- **Live Venue AI-Policy Retrieval & General Disclosure Templates**: Upgraded `paper-writer/modules/ai-use-drafter` with structured English/Chinese disclosure templates and mandatory live official CFP/publisher AI-policy lookup when a target venue is specified.
- **Preserved Empirical Lineage & Anti-Rejection Rules**: Retained all `v1.4.0` baseline-lineage, FWER multiplicity, and rebuttal-guidance checks within the consolidated skill layout.

### Skill Migration Map (v1.4.0 → v1.5.0)
| Previous Skill(s) | New Location in v1.5.0 |
|---|---|
| `brainstorming-research-ideas`, `creative-thinking-for-research` | Inlined into `research-companion` (`principles/ideation-lenses.md`) |
| `deep-research`, `nature-reader`, `benchmark-research-skill` | `research-lit` (`modules/deep-research`, `modules/paper-reader`, `modules/benchmark-research`) |
| `run-experiment`, `human-annotation-page` | `experiment-bridge` (`references/run-execution.md`, `modules/human-annotation-page`) |
| `tech-paper-template`, `benchmark-paper-template`, `good-story` | `paper-outline` (`modules/*`) |
| `intro-drafter`, `limitation-and-risk-writer`, `ai-use-drafter` | `paper-writer` (`modules/*`) |
| `nature-figure`, `figure-designer`, `drawio-reconstruction` | `paper-figure` (`modules/figure-designer`, `modules/drawio-reconstruction`) |
| `nature-ref-verifier`, `select-venue` | `citation-and-venue` (`modules/ref-verifier`, `modules/select-venue`) |
| `pre-submission-reviewer` | `research-review` (`modules/pre-submission-reviewer`) |
| `nature-response`, `rebuttal-guidance` | `rebuttal-response` (`modules/rebuttal-guidance`) |
| `nature-shared` | Folded into `shared-references/nature-shared` (no standalone skill entry) |
| `vibe-research-workflow`, `ts-paper*` | Retired (replaced by venue-agnostic `paper-outline` & `citation-and-venue`) |

## [v1.4.0] — 2026-11-23
- **Unified 3-Host Support**: First-class setup and session-aware routing for Claude Code, Codex, and Antigravity (`bash install.sh --host <claude|codex|antigravity>`).
- **`debate-hub` MCP Plugin**: Optional multi-agent independent review and topic-comparison plugin producing human decision cards.
- **Ideation & Anti-Rejection Hardening**: Added empirical ideation patterns, 4-axis collision check, Idea Card schema, baseline-lineage discovery, FWER multiplicity guardrails, anti-rejection controls (S1–S4), and upgraded `rebuttal-guidance`.
- **Visual Identity**: Added official project logo and banner.

## [v1.3.0] — 2026-11-19
- **`research-gate` Python Controller**: Disk-backed stage state machine with SHA-256-bound human approvals (topic & frozen protocol) and verbatim source-anchor verification.
- **Method-to-Code Claim Audit**: Extended `paper-claim-audit` to trace pivotal empirical method descriptions to the code and run records that produced them.

## [v1.2.0] — 2026-11-02
- **Post-Topic Autopilot (`/research-autopilot`)**: Delegates routine research decisions after human topic approval and batches resource requests.
- **Local Memory Guard**: Added Linux `systemd-run` memory caps, detached execution, and durable idempotent JSONL result tracking.

## [v1.1.0] — 2026-11-01
- **Codex Host Support**: Added shared skill build for Codex, `/research-auto`, `codex-exec` independent reviewer MCP bridge, and lightweight experiment record checks.

## [v1.0.0] — 2026-10-20
- **Initial Release**: Full CS research skill suite for Claude Code with shared evidence, citation, and research-autonomy policies.
