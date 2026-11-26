"""Deterministic stage-gate evaluator and preflight checks for research-gate."""
from __future__ import annotations

import json
from pathlib import Path
import re
import subprocess
import sys

from anchors import (audit_stage_ledgers, parse_markdown_tables, referenced_retrievals,
                     table_rows_by_headers, upstream_tables)
from models import (
    GATE_STAGES,
    PRIMARY_ARTIFACT_BY_STAGE,
    script_check_settings,
)
from inputs import (OBSERVED_RUNS, PLANNED_RUNS, SOURCE_SELECTION, approval_matches, approval_version,
                    audit_paper_claim_freshness, claim_audit_file, compute_stale_stages, protocol_artifacts,
                    retrieval_versions, rework_hashes, stage_expected_artifacts, stage_input_hashes, writing_files)
from state import safe_local, stage_index, utc_now


def run_preflight(root: Path, state: dict, skill_root: Path) -> dict:
    errors: list[str] = []
    goal_present = bool((state.get("goal") or "").strip())
    if not goal_present:
        errors.append("Project goal is empty")

    skill_root_exists = skill_root.is_dir()
    if not skill_root_exists:
        errors.append(f"Skill root does not exist: {skill_root}")

    run_records_script = skill_root / "experiment-bridge/scripts/check_run_records.py"
    integrity_script = skill_root / "paper-claim-audit/scripts/integrity/precheck.py"
    figure_script = skill_root / "paper-figure/scripts/validate_figure.py"

    validators = {
        "runRecords": run_records_script.is_file(),
        "integrityPrecheck": integrity_script.is_file(),
        "figureValidator": figure_script.is_file(),
    }

    return {
        "passed": len(errors) == 0,
        "workspaceRoot": str(root),
        "goalPresent": goal_present,
        "paperType": state.get("paperType"),
        "skillRootExists": skill_root_exists,
        "validatorsAvailable": validators,
        "scriptChecks": script_check_settings(state),
        "errors": errors,
        "warnings": [],
    }


def _run_python(script: Path, args: list[str], cwd: Path) -> tuple[int | None, str]:
    try:
        proc = subprocess.run(
            [sys.executable, str(script), *args],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=30,
        )
        output = (proc.stdout or "") + (proc.stderr or "")
        return proc.returncode, output
    except Exception as exc:  # noqa: BLE001
        return None, str(exc)


def _check_figure(validator: Path, script: Path, root: Path, errors: list[str], warnings: list[str]) -> None:
    code, output = _run_python(validator, [str(script), "--json"], root)
    if code == 0:
        return
    if code != 1:
        errors.append(f"Figure validator could not run for {script.name}: {output.strip()[:400]}")
        return
    try:
        failures = [row for row in json.loads(output)["findings"] if row["level"] == "FAIL"]
        if not failures:
            raise ValueError("exit code 1 without a failed check")
        for row in failures:
            # The Python syntax check uses a parser. R delimiters and figure styles use heuristics.
            syntax_error = script.suffix.lower() == ".py" and row["check_id"] == "SOURCE-SYNTAX"
            messages = errors if syntax_error else warnings
            messages.append(f"{script.name} [{row['check_id']}]: {row['message']}")
    except (KeyError, TypeError, ValueError) as exc:
        errors.append(f"Invalid figure validator report for {script.name}: {exc}")


def _evidence_scopes(tables: list[dict]) -> dict[str, str]:
    scopes = {}
    for row in table_rows_by_headers(tables, ["Evidence ID", "Source Ref", "Level", "Verbatim Anchor"]):
        eid = row["Evidence ID"].replace("`", "").strip()
        loc = row.get("Location", "").replace("`", "").strip().lower()
        rs = row.get("Read Scope", "").replace("`", "").strip().lower()
        if rs:
            scopes[eid] = rs
        elif loc in {"abstract", "title/abstract", "abstract-only", "摘要"}:
            scopes[eid] = "abstract"
        elif loc in {"metadata", "bib", "bibtex"}:
            scopes[eid] = "metadata"
        else:
            scopes[eid] = "unspecified"
    return scopes


def evaluate_stage_gate(
    root: Path,
    state: dict,
    stage: str,
    skill_root: Path,
    retrievals_ledger: list[dict],
    stale_map: dict[str, list[str]] | None = None,
) -> dict:
    errors: list[str] = []
    warnings: list[str] = []
    settings = script_check_settings(state)
    applicable_checks: dict[str, bool] = {}

    def use_script(name: str) -> bool:
        applicable_checks[name] = settings[name]
        return settings[name]

    idx = stage_index(stage)
    if stale_map is None:
        stale_map = compute_stale_stages(root, state)

    # 1. Upstream stage gates and staleness.
    for i in range(idx):
        prev = GATE_STAGES[i]
        prev_record = state.get("stages", {}).get(prev)
        stale_reasons = stale_map.get(prev, [])
        if not prev_record or not prev_record.get("passed"):
            errors.append(f"Upstream gate '{prev}' has not passed")
        elif stale_reasons:
            errors.append(f"Upstream gate '{prev}' is stale: {stale_reasons[0]}")

    # 2. SHA-256-bound human approvals (topic + frozen protocol plan).
    for required in ("topic", "plan"):
        if idx <= stage_index(required) or (required == "plan" and not state.get("requirePlanApproval", True)):
            continue
        prior = state.get("stages", {}).get(required, {})
        version = approval_version(root, state, required, prior.get("inputHashes", {}))
        if not approval_matches(root, state, required, version):
            errors.append(f"Missing or stale {required} approval; present the passed version for approval")

    # 3. Rework baseline enforcement.
    reworks = state.get("reworks", {})
    input_hashes = stage_input_hashes(root, state, stage)
    if reworks.get("activeTarget") == stage:
        baseline = reworks.get("baselineHashes", {})
        if reworks.get("scopedBaseline"):
            unchanged = rework_hashes(root, stage, input_hashes) == baseline
        else:
            # An in-flight legacy rework recorded only its primary artifact.
            unchanged = bool(baseline) and all(input_hashes.get(rel) == old for rel, old in baseline.items())
        if unchanged:
            errors.append(f"Active rework for '{stage}' requires changing target artifacts before re-passing the gate")

    # 4. Required artifacts check.
    required_artifacts = stage_expected_artifacts(root, state, stage)
    for rel in required_artifacts:
        abs_path = safe_local(root, rel)
        if not abs_path.is_file() or abs_path.stat().st_size == 0:
            errors.append(f"Missing or empty required artifact for '{stage}': {rel}")

    primary_rel = PRIMARY_ARTIFACT_BY_STAGE[stage]
    primary_abs = safe_local(root, primary_rel)
    primary_content = primary_abs.read_text(encoding="utf-8") if primary_abs.is_file() else ""
    if primary_content and not primary_content.strip():
        errors.append(f"Empty stage report: {primary_rel}")

    # 5. Ledger, verbatim anchor, citation, and validator checks across the workflow.
    if primary_content:
        history = upstream_tables(root, stage)
        ledger_audit = audit_stage_ledgers(
            root,
            state,
            stage,
            primary_content,
            retrievals_ledger,
            require_evidence=stage in {"literature", "plan", "analysis", "writing"},
            require_claims=stage in {"plan", "analysis", "writing"},
            require_implementation_grade_claims=stage in {"analysis", "writing", "review", "delivery"},
            enforce_full_text_for_body_claims=stage in {"analysis", "writing", "review", "delivery"},
            check_citations=stage in {"literature", "plan", "analysis", "writing", "review", "delivery"},
            upstream_evidence_scopes=_evidence_scopes([table for group in history for table in group]),
            history=history,
        )
        errors.extend(ledger_audit["errors"])
        warnings.extend(ledger_audit["warnings"])

        tables = parse_markdown_tables(primary_content)

        if stage == "plan":
            _, contract_errors = protocol_artifacts(root)
            errors.extend(contract_errors)
            if not table_rows_by_headers(tables, ["Scenario ID", "Criterion", "Status"]):
                errors.append("Protocol must define at least one SCN-* acceptance/stopping criterion row")

        if stage == "experiment":
            if PLANNED_RUNS in stage_expected_artifacts(root, state, "plan"):
                planned = safe_local(root, PLANNED_RUNS)
                observed = safe_local(root, OBSERVED_RUNS)
                validator = skill_root / "experiment-bridge/scripts/check_run_records.py"
                if planned.is_file() and observed.is_file() and use_script("run-records"):
                    if not validator.is_file():
                        errors.append(f"Missing run-records validator: {validator}")
                    else:
                        code, out = _run_python(validator, ["--planned", str(planned), "--observed", str(observed)], root)
                        if code != 0:
                            errors.append(f"Run-records validator failed: {out.strip()[:500]}")
                        else:
                            try:
                                parsed = json.loads(out)
                                counts = parsed.get("attempt_status_counts") or {}
                                if counts.get("running") or counts.get("pending") or counts.get("planned"):
                                    errors.append("Unfinished experiment attempts (running/pending/planned) cannot pass experiment gate")
                            except json.JSONDecodeError:
                                errors.append("Run-records validator produced non-JSON output")
            if SOURCE_SELECTION in required_artifacts:
                selection_abs = safe_local(root, SOURCE_SELECTION)
                if selection_abs.is_file():
                    try:
                        entries = json.loads(selection_abs.read_text(encoding="utf-8"))
                        if not isinstance(entries, list) or not entries:
                            raise ValueError("Survey source-selection.json must be a non-empty list")
                        seen_ids: set[str] = set()
                        has_include = False
                        for item in entries:
                            if not isinstance(item, dict):
                                raise ValueError("Each selection entry must be an object")
                            sid = item.get("sourceId")
                            dec = item.get("decision")
                            reason = (item.get("reason") or "").strip()
                            if not isinstance(sid, str) or not sid or dec not in {"include", "exclude"} or not reason:
                                raise ValueError("Invalid entry fields in research/source-selection.json")
                            if sid in seen_ids:
                                errors.append("Duplicate sourceId in research/source-selection.json")
                            seen_ids.add(sid)
                            if dec == "include":
                                has_include = True
                            if sid not in state.get("sources", {}):
                                errors.append(f"Survey selection references unregistered source: {sid}")
                        if not has_include:
                            errors.append("Survey source-selection.json has no included source")
                    except Exception as exc:  # noqa: BLE001
                        errors.append(f"Invalid research/source-selection.json: {exc}")

        if stage == "writing":
            tex_files, plot_scripts = writing_files(root)
            if tex_files and use_script("latex-integrity"):
                precheck = skill_root / "paper-claim-audit/scripts/integrity/precheck.py"
                if not precheck.is_file():
                    errors.append(f"Missing LaTeX integrity precheck script: {precheck}")
                else:
                    out_dir = root / ".research-gate/checks/integrity"
                    code, out = _run_python(
                        precheck,
                        ["--latex", *[str(p) for p in tex_files], "--out-dir", str(out_dir)],
                        root,
                    )
                    if code != 0:
                        errors.append(f"LaTeX integrity precheck failed: {out.strip()[:500]}")
                    elif re.match(r"[1-9]\d* finding\(s\)", out):
                        warnings.append(out.strip())

            if plot_scripts and use_script("figures"):
                fig_val = skill_root / "paper-figure/scripts/validate_figure.py"
                if not fig_val.is_file():
                    errors.append(f"Missing figure validator: {fig_val}")
                else:
                    for script in plot_scripts:
                        _check_figure(fig_val, script, root, errors, warnings)

        if stage in {"review", "delivery"}:
            audit_abs = safe_local(root, claim_audit_file(root))
            if audit_abs.is_file():
                try:
                    freshness = audit_paper_claim_freshness(audit_abs)
                    errors.extend(freshness["errors"])
                    if freshness["verdict"] in {"FAIL", "BLOCKED", "ERROR"}:
                        errors.append(f"{audit_abs.name} verdict is {freshness['verdict']}")
                except (OSError, ValueError, TypeError, AttributeError) as exc:
                    errors.append(f"Invalid {audit_abs.name}: {exc}")

        if stage == "review":
            review_rows = table_rows_by_headers(tables, ["Reviewer", "Verdict", "Summary"])
            completed_reviews = [
                row for row in review_rows
                if all(row[key].strip("` ") for key in ("Reviewer", "Verdict", "Summary"))
                and row["Verdict"].strip("` ").upper() != "ERROR"
            ]
            if not completed_reviews:
                errors.append("research/review.md must record at least one completed Reviewer / Verdict / Summary row")
            for row in completed_reviews:
                if row["Verdict"].strip("` ").upper() not in {"PASS", "NOT_APPLICABLE"}:
                    warnings.append(f"{row['Reviewer']} ({row['Verdict']}): {row['Summary']}")

    passed = len(errors) == 0
    needs_approval = stage == "topic" or (stage == "plan" and state.get("requirePlanApproval", True))
    version = approval_version(root, state, stage, input_hashes)
    awaiting_approval = passed and needs_approval and not approval_matches(root, state, stage, version)

    return {
        "stage": stage,
        "passed": passed,
        "status": "blocked" if not passed else ("awaiting_approval" if awaiting_approval else "passed"),
        "artifact": primary_rel,
        "artifactHash": input_hashes.get(primary_rel),
        "approvalVersion": version if stage in {"topic", "plan", "delivery"} else None,
        "retrievalVersions": retrieval_versions(referenced_retrievals(primary_content, retrievals_ledger)),
        "inputHashes": input_hashes,
        "scopedInputs": True,
        "scriptChecks": applicable_checks,
        "errors": errors,
        "warnings": warnings,
        "checkedAt": utc_now(),
    }
