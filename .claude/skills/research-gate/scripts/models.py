"""Domain models, stage ordering, and paper-type profiles for research-gate."""
from __future__ import annotations

GATE_STAGES: tuple[str, ...] = (
    "topic",
    "literature",
    "plan",
    "experiment",
    "analysis",
    "writing",
    "review",
    "delivery",
)

APPROVAL_STAGES: tuple[str, ...] = ("topic", "plan", "delivery")

SCRIPT_CHECK_STAGES = {"run-records": "experiment", "latex-integrity": "writing", "figures": "writing"}


def script_check_settings(state: dict) -> dict[str, bool]:
    saved = state.get("scriptChecks", {})
    return {name: saved.get(name, True) for name in SCRIPT_CHECK_STAGES}

EVIDENCE_LEVELS: tuple[str, ...] = (
    "verified",
    "user-confirmed",
    "source-backed",
    "inferred",
    "missing",
)

IMPLEMENTATION_GRADE_LEVELS: frozenset[str] = frozenset(
    {"verified", "user-confirmed", "source-backed"}
)

VALID_VERDICTS: frozenset[str] = frozenset(
    {"PASS", "WARN", "FAIL", "NOT_APPLICABLE", "BLOCKED", "ERROR"}
)

PRIMARY_ARTIFACT_BY_STAGE: dict[str, str] = {
    "topic": "research/topic.md",
    "literature": "research/literature.md",
    "plan": "research/protocol.md",
    "experiment": "research/execution.md",
    "analysis": "research/analysis.md",
    "writing": "research/manuscript.md",
    "review": "research/review.md",
    "delivery": "research/delivery.md",
}

PAPER_PROFILES: dict[str, dict] = {
    "method": {
        "plan_skills": ["experiment-plan"],
        "execution_skills": ["experiment-bridge", "run-experiment"],
        "analysis_skills": ["analyze-results"],
        "writing_skills": ["tech-paper-template", "paper-writer", "nature-figure"],
        "artifacts": {"plan": ["research/planned-runs.json"], "experiment": ["research/observed-runs.json"], "analysis": []},
    },
    "system": {
        "plan_skills": ["experiment-plan"],
        "execution_skills": ["experiment-bridge", "run-experiment"],
        "analysis_skills": ["analyze-results"],
        "writing_skills": ["tech-paper-template", "paper-writer", "nature-figure"],
        "artifacts": {
            "plan": ["research/system-design.md", "research/planned-runs.json"],
            "experiment": ["research/observed-runs.json"],
            "analysis": ["research/system-tradeoffs.md"],
        },
    },
    "benchmark": {
        "plan_skills": ["benchmark-research-skill", "experiment-plan"],
        "execution_skills": ["experiment-bridge", "run-experiment"],
        "analysis_skills": ["analyze-results"],
        "writing_skills": ["benchmark-paper-template", "paper-writer", "nature-figure"],
        "artifacts": {
            "plan": ["research/benchmark-protocol.md", "research/planned-runs.json"],
            "experiment": ["research/observed-runs.json"],
            "analysis": ["research/benchmark-validity.md"],
        },
    },
    "empirical": {
        "plan_skills": ["experiment-plan"],
        "execution_skills": ["experiment-bridge", "run-experiment"],
        "analysis_skills": ["analyze-results"],
        "writing_skills": ["paper-writer", "nature-figure"],
        "artifacts": {
            "plan": ["research/analysis-design.md", "research/planned-runs.json"],
            "experiment": ["research/observed-runs.json"],
            "analysis": [],
        },
    },
    "replication": {
        "plan_skills": ["experiment-plan"],
        "execution_skills": ["experiment-bridge", "run-experiment"],
        "analysis_skills": ["analyze-results"],
        "writing_skills": ["paper-writer", "nature-figure"],
        "artifacts": {
            "plan": ["research/replication-protocol.md", "research/planned-runs.json"],
            "experiment": ["research/replication-deviations.md", "research/observed-runs.json"],
            "analysis": [],
        },
    },
    "theory": {
        "plan_skills": [],
        "execution_skills": [],
        "analysis_skills": [],
        "writing_skills": ["paper-writer"],
        "artifacts": {
            "plan": ["research/definitions.md"],
            "experiment": ["research/proofs.md"],
            "analysis": [],
        },
    },
    "survey": {
        "plan_skills": ["research-lit"],
        "execution_skills": ["research-lit"],
        "analysis_skills": ["research-lit"],
        "writing_skills": ["paper-writer"],
        "artifacts": {
            "plan": ["research/search-protocol.md"],
            "experiment": ["research/source-selection.json"],
            "analysis": [],
        },
    },
    "position": {
        "plan_skills": [],
        "execution_skills": ["research-lit"],
        "analysis_skills": [],
        "writing_skills": ["good-story", "paper-writer"],
        "artifacts": {
            "plan": ["research/argument-plan.md"],
            "experiment": ["research/argument-evidence.md"],
            "analysis": [],
        },
    },
}

DEFAULT_PROFILE: dict = {
    "plan_skills": [],
    "execution_skills": [],
    "analysis_skills": [],
    "writing_skills": ["paper-writer"],
    "artifacts": {"plan": [], "experiment": [], "analysis": []},
}


def get_paper_profile(paper_type: str | None) -> dict:
    return PAPER_PROFILES.get(paper_type, DEFAULT_PROFILE)


def retrieval_intents_for(stage: str, target_venue: str | None) -> dict[str, list[str]]:
    """Map each research purpose to the alternative ledger intents that can cover it."""
    if stage == "literature":
        return {"counterevidence": ["adversarial"]}
    if stage == "plan":
        purposes = {"protocolCalibration": ["methodology", "support", "adversarial"]}
        if target_venue:
            purposes["venueRequirements"] = ["venue"]
        return purposes
    return {}


def recommended_skills_for(stage: str, paper_type: str | None, *, planned_runs: bool | None = None) -> list[str]:
    profile = get_paper_profile(paper_type)
    mapping = {
        "topic": ["brainstorming-research-ideas", "research-companion", "idea-evaluator", "novelty-check"],
        "literature": ["research-lit", "deep-research", "nature-reader", "nature-ref-verifier"],
        "plan": ["select-venue", *profile["plan_skills"]],
        "experiment": list(profile["execution_skills"]),
        "analysis": list(profile["analysis_skills"]),
        "writing": list(dict.fromkeys([*profile["writing_skills"], "good-story", "ts-paper-plan", "ts-paper-cite"])),
        "review": ["research-review", "pre-submission-reviewer", "paper-claim-audit", "paper-polish", "nature-ref-verifier"],
        "delivery": ["limitation-and-risk-writer", "ai-use-drafter"],
    }
    skills = mapping[stage]
    run_skills = {"experiment": ["experiment-bridge", "run-experiment"], "analysis": ["analyze-results"]}
    if planned_runs is None or stage not in run_skills:
        return skills
    if planned_runs:
        return list(dict.fromkeys([*skills, *run_skills[stage]]))
    return [skill for skill in skills if skill not in run_skills[stage]]
