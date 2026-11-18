"""High-level controller actions for the modular skills-version research-gate."""
from __future__ import annotations

from pathlib import Path
import shutil

from anchors import RETRIEVAL_ID_RE, gap_register, parse_markdown_tables, upstream_tables
from gates import evaluate_stage_gate, run_preflight
from inputs import (PLANNED_RUNS, SCRIPT_RECHECK, approval_matches, approval_version, compute_stale_stages, protocol_artifacts, rework_hashes,
                    stage_expected_artifacts, stage_input_hashes)
from models import (
    APPROVAL_STAGES,
    GATE_STAGES,
    PRIMARY_ARTIFACT_BY_STAGE,
    SCRIPT_CHECK_STAGES,
    get_paper_profile,
    recommended_skills_for,
    retrieval_intents_for,
    script_check_settings,
)
from state import (
    GATE_STATE_FILE,
    GateStore,
    resolve_artifact_hashes,
    safe_local,
    stage_index,
    utc_now,
)


def init_gate(
    root: str | Path,
    *,
    goal: str,
    paper_type: str | None = None,
    target_venue: str | None = None,
    report_language: str | None = None,
    max_revisions: int = 3,
    require_plan_approval: bool = True,
    disabled_checks: tuple[str, ...] | list[str] = (),
    skill_root: Path,
) -> dict:
    if not goal.strip():
        raise ValueError("Goal must be non-empty")
    unknown_checks = set(disabled_checks).difference(SCRIPT_CHECK_STAGES)
    if unknown_checks:
        raise ValueError(f"Unknown script checks: {sorted(unknown_checks)}")
    store = GateStore(root)
    if store.exists():
        raise FileExistsError(f"Gate workspace already exists at {store.file}")

    now = utc_now()
    state = {
        "version": 2,
        "mode": "gated",
        "goal": goal.strip(),
        "paperType": (paper_type or "").strip() or None,
        "targetVenue": target_venue.strip() if target_venue else None,
        "reportLanguage": (report_language or "").strip() or None,
        "requirePlanApproval": require_plan_approval,
        "scriptChecks": {name: name not in disabled_checks for name in SCRIPT_CHECK_STAGES},
        "createdAt": now,
        "updatedAt": now,
        "sources": {},
        "approvals": {},
        "stages": {},
        "reworks": {
            "count": 0,
            "maxRevisions": max_revisions,
            "baselineHashes": {},
            "history": [],
        },
    }
    store.write(state)
    store.append_event("gate_workspace_initialized", {"goal": state["goal"], "paperType": state["paperType"], "targetVenue": state["targetVenue"]})
    scaffold = scaffold_stage(store.root, "topic", skill_root)
    return {"state": state, "scaffolded": scaffold["created"]}


def scaffold_stage(root: str | Path, stage: str, skill_root: Path, force: bool = False) -> dict:
    if stage not in GATE_STAGES:
        raise ValueError(f"Invalid stage: {stage}")
    templates_dir = skill_root / "research-gate/templates"
    target_rel = PRIMARY_ARTIFACT_BY_STAGE[stage]
    template_path = templates_dir / Path(target_rel).name
    dest_abs = safe_local(Path(root).resolve(), target_rel)
    created: list[str] = []
    skipped: list[str] = []

    if template_path.is_file():
        if not dest_abs.exists() or force:
            dest_abs.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(template_path, dest_abs)
            created.append(target_rel)
        else:
            skipped.append(target_rel)
    return {"stage": stage, "created": created, "skipped": skipped}


def preflight_gate(root: str | Path, skill_root: Path) -> dict:
    store = GateStore(root)
    state = store.read()
    return run_preflight(store.root, state, skill_root)


def set_script_check(root: str | Path, name: str, *, enabled: bool) -> dict[str, bool]:
    if name not in SCRIPT_CHECK_STAGES:
        raise ValueError(f"Unknown script check: {name}")
    store = GateStore(root)
    state = store.read()
    settings = script_check_settings(state)
    if settings[name] != enabled:
        settings[name] = enabled
        state["scriptChecks"] = settings
        store.write(state)
        store.append_event("script_check_changed", {"name": name, "enabled": enabled})
    return settings


def set_paper_type(root: str | Path, paper_type: str) -> dict:
    if not paper_type.strip():
        raise ValueError("Provide a contribution label or description")
    store = GateStore(root)
    state = store.read()
    state["paperType"] = paper_type.strip()
    store.write(state)
    store.append_event("paper_type_selected", {"paperType": state["paperType"]})
    return state


def register_source(
    root: str | Path,
    *,
    source_id: str,
    title: str,
    identity: str,
    file_path: str | None = None,
    content: str | None = None,
    citation_keys: list[str] | None = None,
) -> dict:
    store = GateStore(root)
    state = store.read()
    source = store.save_source_snapshot(
        source_id,
        title,
        identity,
        file_path=file_path,
        content=content,
        citation_keys=citation_keys,
    )
    state["sources"][source["id"]] = source
    store.write(state)
    store.append_event("source_registered", {"id": source["id"], "path": source["path"], "sha256": source["sha256"]})
    return source


def record_retrieval(
    root: str | Path,
    *,
    retrieval_id: str,
    intent: str,
    provider: str,
    query: str,
    source_ref: str,
    status: str,
    source_id: str | None = None,
) -> dict:
    if not RETRIEVAL_ID_RE.fullmatch(retrieval_id):
        raise ValueError("Expected a RET-* retrieval ID")
    if intent not in {"support", "adversarial", "venue", "methodology"}:
        raise ValueError(f"Invalid retrieval intent: {intent}")
    if status not in {"planned", "attempted", "satisfied", "not-applicable"}:
        raise ValueError(f"Invalid retrieval status: {status}")
    store = GateStore(root)
    if not store.exists():
        raise FileNotFoundError(f"Gate workspace not initialized at {store.file}")
    record = {
        "id": retrieval_id,
        "intent": intent,
        "provider": provider,
        "query": query,
        "sourceRef": source_ref,
        "status": status,
        "recordedAt": utc_now(),
        **({"sourceId": source_id} if source_id else {}),
    }
    store.append_retrieval(record)
    store.append_event("retrieval_recorded", {"id": retrieval_id, "intent": intent, "status": status, "sourceRef": source_ref})
    return record


def save_gate_result(root: Path, state: dict, result: dict, stale_before: dict) -> None:
    stage = result["stage"]
    stages = state.setdefault("stages", {})
    previous = stages.get(stage)
    old_approval = state.get("approvals", {}).get(stage)
    approval_changed = old_approval and not approval_matches(root, state, stage, result.get("approvalVersion"))
    # Running a newly enabled script against unchanged inputs preserves downstream acceptance on success.
    stale_reasons = stale_before.get(stage, [])
    inputs_changed = bool(stale_reasons) and stale_reasons != [SCRIPT_RECHECK]
    if previous and previous.get("passed") and (inputs_changed or approval_changed or not result["passed"]):
        for downstream in GATE_STAGES[stage_index(stage) + 1:]:
            saved = stages.get(downstream)
            if saved and saved.get("passed"):
                saved["changedUpstream"] = stage
    if old_approval and not approval_changed:
        old_approval["version"] = result["approvalVersion"]
    if stage == "plan" and result["passed"] and state.get("version", 1) == 1 and protocol_artifacts(root)[0] is not None:
        state["version"] = 2
    stages[stage] = result
    reworks = state.get("reworks", {})
    if result["passed"] and reworks.get("activeTarget") == stage:
        reworks.pop("activeTarget")
        reworks.pop("activeReason", None)
        reworks.pop("scopedBaseline", None)
        reworks["baselineHashes"] = {}
    if result["status"] == "awaiting_approval":
        state.get("approvals", {}).pop(stage, None)


def extend_legacy_rework_baseline(store: GateStore, state: dict) -> None:
    reworks = state.get("reworks", {})
    target = reworks.get("activeTarget")
    if not target or reworks.get("scopedBaseline"):
        return
    # Retain the historical primary hash. Supporting files become comparable
    # from this first resume, before the host performs the next repair.
    current = stage_input_hashes(store.root, state, target)
    baseline = rework_hashes(store.root, target, current)
    baseline.pop(PRIMARY_ARTIFACT_BY_STAGE[target], None)
    baseline.update(reworks.get("baselineHashes", {}))
    reworks.update(baselineHashes=baseline, scopedBaseline=True)
    store.write(state)
    store.append_event("rework_baseline_extended", {"target": target, "baselineHashes": baseline})


def run_gate_check(root: str | Path, stage: str, skill_root: Path) -> dict:
    if stage not in GATE_STAGES:
        raise ValueError(f"Invalid stage: {stage}")
    store = GateStore(root)
    state = store.read()
    preflight = run_preflight(store.root, state, skill_root)
    if not preflight["passed"]:
        raise RuntimeError(f"Environment preflight failed: {'; '.join(preflight['errors'])}")

    extend_legacy_rework_baseline(store, state)
    retrievals = store.read_retrievals()
    stale_before = compute_stale_stages(store.root, state)
    gate_result = evaluate_stage_gate(store.root, state, stage, skill_root, retrievals, stale_before)
    save_gate_result(store.root, state, gate_result, stale_before)

    closure = None
    if gate_result["passed"]:
        idx = stage_index(stage)
        next_stage = GATE_STAGES[idx + 1] if idx + 1 < len(GATE_STAGES) else None
        requires_approval = stage if gate_result["status"] == "awaiting_approval" else None
        closure = {
            "stage": stage,
            "passedAt": gate_result["checkedAt"],
            "artifact": gate_result["artifact"],
            "artifactHash": gate_result.get("artifactHash") or "",
            "canClear": True,
            "clearHint": (
                f"Gate '{stage}' passed. Present this approvalVersion to the user before advancing. "
                "State is persisted on disk; /clear + continue reconstructs cleanly."
                if requires_approval
                else f"Gate '{stage}' passed and boundary closed on disk. You may /clear and run continue to reconstruct context for '{next_stage or 'delivery'}'."
            ),
            "nextStage": next_stage,
            "requiresApproval": requires_approval,
            "approvalVersion": gate_result["approvalVersion"],
            "reconstructionCommand": f"research_gate.py continue --root {store.root}",
        }
        state["lastBoundary"] = closure

    store.write(state)
    store.append_event(
        "gate_passed" if gate_result["passed"] else "gate_failed",
        {"stage": stage, "status": gate_result["status"], "errors": gate_result["errors"], "artifactHash": gate_result.get("artifactHash")},
    )
    out = {"result": gate_result}
    if closure is not None:
        out["boundaryClosure"] = closure
    return out


def approve_stage(
    root: str | Path,
    stage: str,
    *,
    by: str,
    response: str,
    version: str,
    paper_type: str | None = None,
    skill_root: Path,
) -> dict:
    if stage not in APPROVAL_STAGES:
        raise ValueError(f"Invalid approval stage: {stage}")
    if not by.strip():
        raise ValueError("Explicit approver (--by) is required")
    if not response.strip():
        raise ValueError("Explicit user approval response (--response) is required")

    store = GateStore(root)
    state = store.read()
    if paper_type is not None and paper_type.strip() != state.get("paperType"):
        raise ValueError("Set the paper type and present its updated topic before approval")
    presented = state.get("stages", {}).get(stage, {})
    if not presented.get("passed") or presented.get("approvalVersion") != version:
        raise ValueError("Approval version differs from the passed gate; present the current version")
    extend_legacy_rework_baseline(store, state)
    retrievals = store.read_retrievals()
    stale_before = compute_stale_stages(store.root, state)
    check = evaluate_stage_gate(store.root, state, stage, skill_root, retrievals, stale_before)
    if check.get("approvalVersion") != version:
        raise ValueError("The proposal changed since presentation; re-gate and present the revised version")
    save_gate_result(store.root, state, check, stale_before)
    if not check["passed"]:
        store.write(state)
        raise RuntimeError(f"Cannot approve '{stage}' before its gate passes: {'; '.join(check['errors'])}")

    artifact = PRIMARY_ARTIFACT_BY_STAGE[stage]
    digest = check["artifactHash"]
    approval = {
        "stage": stage,
        "artifact": artifact,
        "sha256": digest,
        "version": version,
        "approvedBy": by.strip(),
        "response": response.strip(),
        "approvedAt": utc_now(),
        **({"paperType": state.get("paperType")} if stage == "topic" else {}),
    }
    state.setdefault("approvals", {})[stage] = approval
    state["stages"][stage]["status"] = "passed"
    store.write(state)
    store.append_event("stage_approved", {"stage": stage, "by": by.strip(), "sha256": digest, "version": version, "paperType": state.get("paperType")})
    return state


def rework_stage(root: str | Path, target_stage: str, reason: str) -> dict:
    if target_stage not in GATE_STAGES:
        raise ValueError(f"Invalid target stage: {target_stage}")
    if not reason.strip():
        raise ValueError("Explicit rework reason is required")
    if target_stage == "topic":
        raise ValueError("Topic reselection requires explicit user reset rather than automatic rework")

    store = GateStore(root)
    state = store.read()
    reworks = state.setdefault("reworks", {"count": 0, "maxRevisions": 3, "baselineHashes": {}, "history": []})
    if reworks["count"] >= reworks["maxRevisions"]:
        raise RuntimeError(f"Workflow rework budget exhausted ({reworks['count']}/{reworks['maxRevisions']})")

    baseline = stage_input_hashes(store.root, state, target_stage)
    baseline = rework_hashes(store.root, target_stage, baseline)
    reworks["scopedBaseline"] = True
    reworks["count"] += 1
    reworks["activeTarget"] = target_stage
    reworks["activeReason"] = reason.strip()
    reworks["baselineHashes"] = baseline
    reworks["history"].append(
        {"target": target_stage, "reason": reason.strip(), "requestedAt": utc_now(), "baselineHashes": baseline}
    )

    for s in GATE_STAGES[stage_index(target_stage) :]:
        state.get("stages", {}).pop(s, None)
        if s in {"plan", "delivery"}:
            state.get("approvals", {}).pop(s, None)

    store.write(state)
    store.append_event("rework_requested", {"target": target_stage, "reason": reason.strip(), "cycle": reworks["count"]})
    return state


def status_gate(root: str | Path) -> dict:
    store = GateStore(root)
    state = store.read()
    stale_map = compute_stale_stages(store.root, state)
    settings = script_check_settings(state)

    stages_view: list[dict] = []
    for stage in GATE_STAGES:
        artifact = PRIMARY_ARTIFACT_BY_STAGE[stage]
        abs_path = safe_local(store.root, artifact)
        saved = state.get("stages", {}).get(stage)
        stale_reasons = stale_map.get(stage, [])
        approval = state.get("approvals", {}).get(stage) if stage in APPROVAL_STAGES else None
        version = None
        if stage in APPROVAL_STAGES and saved:
            hashes = resolve_artifact_hashes(store.root, stage_expected_artifacts(store.root, state, stage))
            version = approval_version(store.root, state, stage, hashes)
        approval_valid = approval_matches(store.root, state, stage, version) if approval else None

        status = "pending"
        if stale_reasons:
            status = "stale"
        elif saved and saved.get("passed"):
            if (stage == "topic" or (stage == "plan" and state.get("requirePlanApproval", True))) and not approval_valid:
                status = "awaiting_approval" if saved.get("approvalVersion") else "stale"
                if status == "stale":
                    stale_reasons = ["Re-gate once to identify the version for approval in this older workspace"]
            else:
                status = "passed"
        elif saved and not saved.get("passed"):
            status = "blocked"
            prior = saved.get("scriptChecks", {name: True for name, owner in SCRIPT_CHECK_STAGES.items() if owner == stage})
            if any(settings[name] != enabled for name, enabled in prior.items()):
                status = "stale"
                stale_reasons = ["Script settings changed since this gate failed. Re-run the gate."]

        item = {
            "stage": stage,
            "artifact": artifact,
            "exists": abs_path.is_file(),
            "status": status,
            "staleReasons": stale_reasons,
            "errors": saved.get("errors", []) if saved and status == "blocked" else [],
            "approvalVersion": saved.get("approvalVersion") if saved else None,
        }
        if approval_valid is not None:
            item["approved"] = approval_valid
        stages_view.append(item)

    reworks = state.get("reworks", {})
    out = {
        "workspace": str(store.root),
        "scriptChecks": settings,
        "stateFile": GATE_STATE_FILE,
        "reportLanguage": state.get("reportLanguage"),
        "goal": state.get("goal", ""),
        "paperType": state.get("paperType"),
        "targetVenue": state.get("targetVenue"),
        "reworkCount": reworks.get("count", 0),
        "maxRevisions": reworks.get("maxRevisions", 3),
        "stages": stages_view,
        "lastBoundary": state.get("lastBoundary"),
    }
    if reworks.get("activeTarget"):
        out["activeRework"] = {"target": reworks["activeTarget"], "reason": reworks.get("activeReason", "")}
    return out


def continue_gate(root: str | Path, skill_root: Path) -> dict:
    status = status_gate(root)
    store = GateStore(root)
    state = store.read()
    extend_legacy_rework_baseline(store, state)
    preflight = run_preflight(store.root, state, skill_root)

    passed_stages = [s["stage"] for s in status["stages"] if s["status"] == "passed"]
    ctx = {
        "scriptChecks": status["scriptChecks"],
        "reportLanguage": status["reportLanguage"],
        "goal": state.get("goal", ""),
        "paperType": state.get("paperType"),
        "targetVenue": state.get("targetVenue"),
        "passedStages": passed_stages,
        "registeredSources": list(state.get("sources", {}).keys()),
        **({"activeRework": status["activeRework"]} if "activeRework" in status else {}),
    }

    if not preflight["passed"]:
        return {
            "action": "fix_gate",
            "stage": "topic",
            "artifact": PRIMARY_ARTIFACT_BY_STAGE["topic"],
            "requiredArtifacts": stage_expected_artifacts(store.root, state, "topic"),
            "reason": f"Preflight failed: {'; '.join(preflight['errors'])}",
            "recommendedSkills": [],
            "blockers": preflight["errors"],
            "reconstructionContext": ctx,
        }

    for entry in status["stages"]:
        if entry["status"] == "passed":
            continue
        stage = entry["stage"]
        history = upstream_tables(store.root, stage)
        current = safe_local(store.root, entry["artifact"])
        if current.is_file():
            history.append(parse_markdown_tables(current.read_text(encoding="utf-8")))
        ctx["openGaps"] = [row for row in gap_register(history).values()
                           if row["Status"].strip("` ").lower() == "open"]
        if entry["status"] == "awaiting_approval":
            return {
                "action": "await_approval",
                "stage": stage,
                "artifact": entry["artifact"],
                "requiredArtifacts": stage_expected_artifacts(store.root, state, stage),
                "reason": f"Stage '{stage}' passed its machine gate and awaits explicit human approval (SHA-256 bound).",
                "recommendedSkills": [],
                "approvalCommand": f'approve --stage {stage} --version {entry["approvalVersion"]} --by user --response "<decision>"',
                "blockers": [f"Awaiting explicit approval for {stage}"],
                "reconstructionContext": ctx,
            }

        scaffold = scaffold_stage(store.root, stage, skill_root, force=False)
        created_note = f" Scaffolded template {', '.join(scaffold['created'])}." if scaffold["created"] else ""
        blockers = [*entry["staleReasons"], *entry["errors"]]
        action = "fix_gate" if entry["status"] in {"blocked", "stale"} else "work_stage"
        paper_type = state.get("paperType")
        planned_runs = None
        if stage in {"experiment", "analysis"}:
            planned_runs = PLANNED_RUNS in stage_expected_artifacts(store.root, state, "plan")
        handoff = {
            "action": action,
            "stage": stage,
            "artifact": entry["artifact"],
            "requiredArtifacts": stage_expected_artifacts(store.root, state, stage),
            "reason": (
                f"Stage '{stage}' is {entry['status']}; review the listed changes or blockers, update affected work as needed, and re-run the gate.{created_note}"
                if action == "fix_gate"
                else f"Complete the required artifacts for '{stage}', then run the gate.{created_note}"
            ),
            "recommendedSkills": recommended_skills_for(stage, paper_type, planned_runs=planned_runs),
            "retrievalIntents": retrieval_intents_for(stage, state.get("targetVenue")),
            "gateCommand": f"gate {stage}",
            "blockers": blockers,
            "reconstructionContext": ctx,
        }
        if stage == "plan":
            handoff["suggestedEvidence"] = get_paper_profile(paper_type)["artifacts"]
        if stage == "review":
            handoff["reviewInstruction"] = (
                "Use research-review for independent review of the current materials. "
                "Reuse a returned review or resume a pending request that covers these materials. "
                "If a new review is needed, dispatch it through the configured reviewer route. "
                "Wait for the reviewer's response before recording its verdict and summary."
            )
        return handoff

    return {
        "action": "completed",
        "stage": None,
        "artifact": None,
        "requiredArtifacts": [],
        "reason": "All 8 research gates passed and verified on disk. Outward-facing submission/publication stays with the user.",
        "recommendedSkills": [],
        "blockers": [],
        "reconstructionContext": ctx,
    }
