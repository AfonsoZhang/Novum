# Empirical Ideation Patterns and Contrastive Failure Modes

Optional technical strategy catalog distilled from ML conference outcomes
(inspired by ResearchStudio-Idea, arXiv:2607.04439). Use it alongside the
general cognitive lenses in `brainstorming-research-ideas` and the facet
recombination rules in `ideation-evidence.md`.

> **Scope rule:** These patterns are structural aids for method and diagnostic
> ideation, not a venue-acceptance predictor or a required checklist. Focused
> improvements, negative findings, replications, evaluations, benchmarks, and
> non-ML research remain valid outside this catalog under the
> [shared topic-selection policy](../../shared-references/topic-selection-policy.md).

## Why Pair Patterns with Failure Modes ("Reject Paradox")

Empirical analysis of accepted (Oral / high-impact) versus rejected submissions
shows that both occupy largely the same macro-strategy space. Choosing a
proven structural pattern does **not** establish contribution or feasibility.
What separates load-bearing work from weak instantiations is whether the
instantiation survives the **pattern-specific execution failure modes** below.

When generating or evaluating an idea that uses one of these patterns:
1. Identify the bottleneck type and the closest pattern(s).
2. Cite concrete supporting precedents from verified literature (never fabricate).
3. Stress-test the candidate directly against that pattern's contrastive failure
   modes in `idea-evaluator` and `research-companion` Phase 3.

## The 15 Reusable Ideation Patterns

| # | Pattern | Target Bottleneck | Core Technical Move | Contrastive Failure Modes (Stress-Test Checks) |
|---|---|---|---|---|
| 1 | **Audit and Pivot an Assumption** | Hidden/stale premise limits existing methods | Isolate an unexamined assumption in dominant baselines, test where it breaks, and replace it | Straw-man assumption nobody relies on in practice; breaking the assumption only under artificial toy settings; no evidence the pivot explains the observed gain |
| 2 | **Substitute the Operator or Representation** | Expressivity, stability, or scaling bottleneck in a core building block | Replace a central operator, parameterization, or representation with a better-matched one | Cosmetic swap with marginal/noisy gains; hidden compute or parameter overhead not matched in baselines; gain disappears when baselines are tuned equally |
| 3 | **Liberate a Fixed Generative Component** | Hard-coded prior, schedule, kernel, or transition restricts capacity | Turn a hand-designed or static component into a learnable, adaptive, or data-driven one | Added degrees of freedom overfit or destabilize training; learned component collapses back to the fixed heuristic; extra tuning cost outweighs benefit |
| 4 | **Design a Confound-Isolating Diagnostic** | Ambiguous attribution or misleading benchmark metrics | Construct a controlled probe, synthetic split, or counterfactual test that separates competing explanations | Diagnostic artifact does not transfer to real tasks; confounds remain uncontrolled (prompt length, compute, data leakage); purely descriptive without actionable takeaway |
| 5 | **Unify Heterogeneous Inputs into One Space** | Modality, scale, or schema fragmentation prevents joint reasoning | Project disparate inputs/tasks into a shared tokenization, latent space, or interface | Forced unification degrades single-modality performance ("negative transfer"); alignment relies on brittle paired data; trivial concatenation marketed as unification |
| 6 | **Reframe as a Solvable Object** | Problem looks intractable under its native formulation | Reformulate the task as an equivalent or tractable problem (e.g., optimal transport, control, graph search, inference) | Reformulation hides the hard part inside an unverified approximation; equivalence holds only under unrealistic assumptions; solver is slower or weaker than direct heuristics |
| 7 | **Manufacture the Supervisory Signal** | Labels or rewards are scarce, noisy, or expensive | Derive self-supervised, synthetic, verifier-based, or structural feedback from cheap signals | Reward hacking or model collapse on self-generated labels; synthetic signal leaks test distribution or fails to correlate with true downstream quality |
| 8 | **Encode Structure by Construction** | Model wastes capacity learning known invariants or constraints | Build symmetries, conservation laws, monotonicity, or hard constraints directly into the architecture/output | Constraint is too rigid for noisy real-world data (underfitting); architectural complexity kills throughput; soft regularization already achieves the same result cheaper |
| 9 | **Prove Equivalence to Unify** | Fragmented literature treats related methods as unrelated | Establish a mathematical or algorithmic equivalence that explains disparate behaviors and yields a cleaner generalization | Superficial analogy without rigorous conditions; equivalence holds only in degenerate limits and predicts no new empirical behavior or design improvement |
| 10 | **Decompose for Differentiated Treatment** | Uniform processing wastes compute or blurs distinct regimes | Split inputs, features, or steps into regimes (easy/hard, slow/fast, local/global) handled by specialized mechanisms | Routing/gating overhead erases savings; decomposition boundary is brittle or dataset-specific; end-to-end monolithic baseline catches up with minimal tuning |
| 11 | **Decompose and Delegate to Solvers** | End-to-end neural model struggles with exact computation or constraints | Factor the problem so learned models handle perception/planning while exact solvers/tools handle structured subproblems | Error propagation at the neural-to-symbolic interface; benchmark specifically engineered to favor the external tool; solver latency dominates end-to-end cost |
| 12 | **Relax Discrete Search to Continuous** | Combinatorial or non-differentiable objective blocks gradient optimization | Introduce a smooth relaxation, surrogate, or continuous latent space enabling gradient-based search | Discretization/rounding gap destroys the relaxed optimum; relaxation introduces severe local minima or high-variance gradient estimators |
| 13 | **Adapt by Conditioning, Not Retraining** | Full fine-tuning per task/user/constraint is too costly or causes forgetting | Steer a frozen or shared backbone via context, lightweight adapters, control tokens, or test-time conditioning | Conditioning fails out-of-distribution where retraining succeeds; prompt/context overhead bloats inference latency; comparison omits strong parameter-efficient baselines |
| 14 | **Characterize a Limit, Then Surpass It** | Existing methods hit an empirical plateau without clear diagnosis | First establish a tight theoretical or empirical failure boundary, then design a targeted intervention that crosses it | Limit is proved only for a weak/straw-man class; proposed fix bypasses the limit by changing the problem setting or resource budget rather than solving it |
| 15 | **Design a Property-Targeting Pretext Objective** | Generic pretraining misses a specific downstream capability | Craft an auxiliary or pretext objective aligned with the missing inductive bias or property | Pretext task is redundant at scale or hurts general capabilities; gains only appear on benchmarks closely resembling the pretext objective |
