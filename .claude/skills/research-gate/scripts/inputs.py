"""Stage inputs shared by gate evaluation, rework and workspace recovery."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re

from anchors import SRC_ID_IN_TEXT_RE, citations_in, parse_markdown_tables, referenced_retrievals, table_rows_by_headers
from models import GATE_STAGES, PRIMARY_ARTIFACT_BY_STAGE, VALID_VERDICTS, get_paper_profile, script_check_settings
from state import GateStore, resolve_artifact_hashes, safe_local, sha256_file


def claim_audit_file(root: Path) -> str:
    canonical = "paper/PAPER_CLAIM_AUDIT.json"
    legacy = "PAPER_CLAIM_AUDIT.json"
    if not (root / canonical).exists() and (root / legacy).is_file():
        return legacy
    return canonical


PLANNED_RUNS = "research/planned-runs.json"
OBSERVED_RUNS = "research/observed-runs.json"
SOURCE_SELECTION = "research/source-selection.json"
SCRIPT_RECHECK = "A script skipped by this gate is now enabled. Re-run the gate."


def protocol_artifacts(root: Path) -> tuple[dict[str, list[str]] | None, list[str]]:
    """Read any extra files the protocol commits to, grouped by the stage that needs them."""
    protocol = safe_local(root, PRIMARY_ARTIFACT_BY_STAGE["plan"])
    tables = parse_markdown_tables(protocol.read_text(encoding="utf-8")) if protocol.is_file() else []
    contracts = [t for t in tables if {"Stage", "Required artifact"}.issubset(t["headers"])]
    if not contracts:
        return None, []

    files: dict[str, list[str]] = {}
    errors = []
    for table in contracts:
        for row in table["rows"]:
            stage = row["Stage"].strip("` ").lower()
            path = row["Required artifact"].strip("` ")
            if stage not in GATE_STAGES[GATE_STAGES.index("plan"):]:
                errors.append(f"Invalid protocol artifact stage '{stage}' for '{path}'")
                continue
            try:
                relative = Path(path)
                if not path or relative.is_absolute():
                    raise ValueError("expected a workspace-relative file path")
                target = safe_local(root, path)
                # A symlink at a standard ledger path still names that ledger.
                if ".." in relative.parts:
                    relative = target.relative_to(root.resolve())
                rel = relative.as_posix()
                if rel == ".":
                    raise ValueError("expected a file path")
            except (OSError, RuntimeError, ValueError) as exc:
                errors.append(f"Invalid protocol artifact '{path}': {exc}")
                continue
            files.setdefault(stage, []).append(rel)
    if PLANNED_RUNS in files.get("plan", []) and OBSERVED_RUNS not in files.get("experiment", []):
        files.setdefault("experiment", []).append(OBSERVED_RUNS)
    return files, errors


def stage_expected_artifacts(root: Path, state: dict, stage: str) -> list[str]:
    files = [PRIMARY_ARTIFACT_BY_STAGE[stage]]
    if stage not in {"topic", "literature"}:
        contract, _ = protocol_artifacts(root)
        if contract is None and state.get("version", 1) == 1:
            # Preserve a legacy protocol's implicit files until its evidence table is adopted.
            contract = get_paper_profile(state.get("paperType"))["artifacts"]
        if contract:
            files.extend(contract.get(stage, []))
    if stage in {"review", "delivery"}:
        files.append(claim_audit_file(root))
    return list(dict.fromkeys(files))


def fingerprint(value: dict) -> str:
    data = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return "sha256:" + hashlib.sha256(data).hexdigest()


def approval_version(root: Path, state: dict, stage: str, hashes: dict) -> str | None:
    primary = PRIMARY_ARTIFACT_BY_STAGE[stage]
    if stage not in {"topic", "plan"}:
        return hashes.get(primary)
    files = stage_expected_artifacts(root, state, stage)
    frozen = {name: hashes.get(name) for name in files}
    return fingerprint({"files": frozen, "paperType": state.get("paperType")})


def approval_matches(root: Path, state: dict, stage: str, version: str | None) -> bool:
    approval = state.get("approvals", {}).get(stage, {})
    if "version" in approval:
        return approval["version"] == version
    if not approval:
        return False
    # Legacy topic approvals contain both original fields. A legacy plan only
    # has a trustworthy file manifest if the saved gate is the one approved.
    record = state["stages"].get(stage, {})
    hashes = record.get("inputHashes", {})
    primary = PRIMARY_ARTIFACT_BY_STAGE[stage]
    if approval.get("sha256") != hashes.get(primary):
        return False
    if stage == "topic" and approval.get("paperType") != state.get("paperType"):
        return False
    if stage == "plan" and (not record.get("checkedAt") or record["checkedAt"] > approval["approvedAt"]):
        return False
    return approval_version(root, state, stage, hashes) == version


def retrieval_versions(refs: dict) -> dict:
    return {rid: fingerprint({k: v for k, v in record.items() if k != "recordedAt"}) if record else None
            for rid, record in refs.items()}


def writing_files(root: Path) -> tuple[list[Path], list[Path]]:
    directory = safe_local(root, "research")
    files = sorted(p for p in directory.iterdir() if p.is_file()) if directory.is_dir() else []
    tex = [p for p in files if p.suffix == ".tex"]
    plots = [p for p in files if re.search(r"(?:fig|plot).*\.(?:py|r)$", p.name, re.I)]
    return tex, plots


def stage_inputs(root: Path, state: dict, stage: str, ledger: list[dict]) -> tuple[set[str], dict]:
    paths = stage_expected_artifacts(root, state, stage)
    check_selection = stage == "experiment" and SOURCE_SELECTION in paths
    primary = safe_local(root, PRIMARY_ARTIFACT_BY_STAGE[stage])
    content = primary.read_text(encoding="utf-8") if primary.is_file() else ""
    source_ids = set(SRC_ID_IN_TEXT_RE.findall(content))
    refs = referenced_retrievals(content, ledger)
    for record in refs.values():
        if record:
            source_ids.update(SRC_ID_IN_TEXT_RE.findall(record.get("sourceRef", "")))
            if record.get("sourceId"):
                source_ids.add(record["sourceId"])
    citations = set(citations_in(content))
    for row in table_rows_by_headers(parse_markdown_tables(content), ["Evidence ID", "Source Ref"]):
        ref = row["Source Ref"].replace("`", "").strip()
        if ref and not SRC_ID_IN_TEXT_RE.search(ref):
            try:
                path = safe_local(root, ref)
            except ValueError:
                continue  # The ledger validator reports invalid evidence paths.
            paths.append(path.relative_to(root).as_posix())

    if check_selection:
        selection = safe_local(root, SOURCE_SELECTION)
        if selection.is_file():
            try:
                rows = json.loads(selection.read_text(encoding="utf-8"))
                if isinstance(rows, list):
                    source_ids.update(row["sourceId"] for row in rows if isinstance(row, dict)
                                      and isinstance(row.get("sourceId"), str))
            except ValueError:
                pass  # Reported by the survey gate.
    for sid, src in state.get("sources", {}).items():
        if sid in source_ids or src["identity"] in citations or citations.intersection(src.get("citationKeys", [])):
            paths.append(src["path"])
    if stage == "writing":
        tex, plots = writing_files(root)
        paths.extend(p.relative_to(root).as_posix() for p in tex + plots)
    return set(paths), retrieval_versions(refs)


def stage_input_hashes(root: Path, state: dict, stage: str) -> dict[str, str]:
    paths, _ = stage_inputs(root, state, stage, GateStore(root).read_retrievals())
    return resolve_artifact_hashes(root, sorted(paths))


def audit_paper_claim_freshness(audit_path: Path) -> dict:
    data = json.loads(audit_path.read_text(encoding="utf-8"))
    errors: list[str] = []
    verdict = data.get("verdict")
    if verdict not in VALID_VERDICTS:
        errors.append("Unknown audit verdict")
    hashes = data.get("audited_input_hashes") or {}
    input_hashes = {}
    if not isinstance(hashes, dict) or not hashes:
        errors.append("Missing audited_input_hashes")
    else:
        for rel, expected in hashes.items():
            target = (audit_path.parent / rel).resolve()
            actual = sha256_file(target) if target.is_file() else None
            input_hashes[str(target)] = actual
            if actual is None or actual != expected:
                errors.append(f"Stale audit input: {rel}")
    return {"verdict": verdict, "stale": bool(errors), "errors": errors, "inputHashes": input_hashes}


def rework_hashes(root: Path, stage: str, input_hashes: dict) -> dict:
    if stage not in {"review", "delivery"}:
        return input_hashes
    # A repair can also restore a manuscript or raw result to its audited contents.
    try:
        audit = audit_paper_claim_freshness(safe_local(root, claim_audit_file(root)))
    except (OSError, ValueError, TypeError, AttributeError):
        return input_hashes  # The stage gate reports the missing or invalid audit.
    hashes = input_hashes.copy()
    for name, digest in audit["inputHashes"].items():
        path = Path(name)
        key = path.relative_to(root) if path.is_relative_to(root) else path
        hashes[key.as_posix()] = digest
    return hashes


def compute_stale_stages(root: Path, state: dict) -> dict[str, list[str]]:
    stale: dict[str, list[str]] = {}
    upstream = None
    ledger = GateStore(root).read_retrievals()
    settings = script_check_settings(state)
    for stage in GATE_STAGES:
        record = state.get("stages", {}).get(stage)
        if not record or not record.get("passed"):
            upstream = upstream or stage
            continue

        reasons = []
        if upstream:
            stale[stage] = [f"Upstream stage '{upstream}' needs review"]
            continue
        if record.get("changedUpstream"):
            reasons.append(f"Review the effect of changes to upstream stage '{record['changedUpstream']}'")
        if any(settings[name] and not ran for name, ran in record.get("scriptChecks", {}).items()):
            reasons.append(SCRIPT_RECHECK)

        expected = record.get("inputHashes", {})
        try:
            relevant, versions = stage_inputs(root, state, stage, ledger)
            current = resolve_artifact_hashes(root, sorted(relevant))
        except (ValueError, OSError) as exc:
            stale[stage] = reasons + [f"Cannot read inputs for '{stage}': {exc}"]
            upstream = upstream or stage
            continue
        paths = current.keys() | expected.keys()
        if not record.get("scopedInputs"):
            # Older gates hashed every registered source. Drop only unused sources;
            # a missing referenced file must still invalidate its gate.
            registered = {src["path"] for src in state.get("sources", {}).values()}
            paths -= registered - relevant
            if stage == "delivery":
                # Old delivery gates delegated the audit-file hash to review.
                rel = claim_audit_file(root)
                review_inputs = state["stages"].get("review", {}).get("inputHashes", {})
                if rel not in expected and rel in review_inputs:
                    expected = {**expected, rel: review_inputs[rel]}
        for rel in sorted(paths):
            if current.get(rel) != expected.get(rel):
                reasons.append(f"Tracked input changed or missing since '{stage}' passed: {rel}")
        if stage in {"topic", "plan"} and record.get("approvalVersion"):
            if record["approvalVersion"] != approval_version(root, state, stage, current):
                reasons.append(f"The frozen {stage} version has changed")
        if None in versions.values() or record.get("retrievalVersions", versions) != versions:
            reasons.append(f"Referenced retrieval records changed or are missing for '{stage}'")
        if stage == "review" and not reasons:
            audit_path = safe_local(root, claim_audit_file(root))
            try:
                reasons.extend(audit_paper_claim_freshness(audit_path)["errors"])
            except (OSError, ValueError, TypeError, AttributeError) as exc:
                reasons.append(f"Invalid claim audit: {exc}")
        if reasons:
            stale[stage] = reasons
            upstream = upstream or stage
    return stale
