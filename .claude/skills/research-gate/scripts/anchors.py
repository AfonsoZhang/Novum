"""Markdown ledger parser, citation checker, and verbatim anchor grounding."""
from __future__ import annotations

from pathlib import Path
import re

from models import (
    PRIMARY_ARTIFACT_BY_STAGE, EVIDENCE_LEVELS, GATE_STAGES, IMPLEMENTATION_GRADE_LEVELS,
    retrieval_intents_for,
)
from state import safe_local, stage_index

SEPARATOR_CELL_RE = re.compile(r"^:?-{3,}:?$")
PLACEHOLDER_RE = re.compile(r"\{\{([A-Za-z0-9_.-]+)\}\}")
BACKTICK_RE = re.compile(r"`([^`\n]+)`")
LATEX_CITE_RE = re.compile(r"\\cite\w*\*?(?:\[[^\]]*\])*\{([^}]+)\}")
MD_URL_RE = re.compile(r"\]\((https?://[^\s)]+)\)")
SRC_ID_IN_TEXT_RE = re.compile(r"\bSRC-[A-Za-z0-9_-]+\b")
RETRIEVAL_ID_RE = re.compile(r"\bRET-[A-Za-z0-9_-]+\b")
GAP_ID_IN_TEXT_RE = re.compile(r"\bGAP-[A-Za-z0-9_-]+\b")
REF_ID_IN_TEXT_RE = re.compile(r"\b(?:EVD|SRC|DEC)-[A-Za-z0-9_-]+\b")

GENERIC_ANCHORS: frozenset[str] = frozenset(
    {"status", "message", "code", "ok", "true", "false", "null", "none", "pass", "fail", "error", "result", "data"}
)

VALID_READ_SCOPES: frozenset[str] = frozenset(
    {"full_text", "abstract", "raw_output", "official_page", "metadata"}
)
SHALLOW_READ_SCOPES: frozenset[str] = frozenset({"abstract", "metadata"})
NARROW_SCOPE_RE = re.compile(r"\b(?:abstract[- ]only|metadata[- ]only|preliminary)\b|仅摘要|摘要级", re.I)


def _clean_cell(value: str) -> str:
    return re.sub(r"<br\s*/?>", " ", value or "", flags=re.IGNORECASE).strip()


def _split_table_line(line: str) -> list[str]:
    trimmed = line.strip().removeprefix("|").removesuffix("|")
    return [_clean_cell(cell) for cell in trimmed.split("|")]


def _is_table_line(line: str) -> bool:
    return bool(re.match(r"^\s*\|.*\|\s*$", line))


def _is_separator_line(line: str) -> bool:
    cells = _split_table_line(line)
    return bool(cells) and all(SEPARATOR_CELL_RE.match(c) for c in cells)


def _is_placeholder_cell(value: str) -> bool:
    cleaned = value.replace("`", "").strip()
    return bool(re.match(r"^\{\{[^}]+\}\}$", cleaned))


def parse_markdown_tables(content: str) -> list[dict]:
    lines = content.splitlines()
    tables: list[dict] = []
    i = 0
    while i < len(lines) - 1:
        if not _is_table_line(lines[i]) or not _is_table_line(lines[i + 1]) or not _is_separator_line(lines[i + 1]):
            i += 1
            continue
        headers = _split_table_line(lines[i])
        rows: list[dict[str, str]] = []
        i += 2
        while i < len(lines) and _is_table_line(lines[i]) and not _is_separator_line(lines[i]):
            cells = _split_table_line(lines[i])
            row = {h: (cells[idx] if idx < len(cells) else "") for idx, h in enumerate(headers)}
            if any(v.replace("`", "").strip() and not _is_placeholder_cell(v) for v in row.values()):
                rows.append(row)
            i += 1
        tables.append({"headers": headers, "rows": rows})
    return tables


def table_rows_by_headers(tables: list[dict], required_headers: list[str]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for table in tables:
        if all(h in table["headers"] for h in required_headers):
            out.extend(table["rows"])
    return out


def detect_unfilled_placeholders(content: str) -> list[str]:
    seen: list[str] = []
    for match in PLACEHOLDER_RE.finditer(content):
        token = match.group(0)
        if token not in seen:
            seen.append(token)
    return seen


def citations_in(content: str) -> list[str]:
    found: list[str] = []
    for match in LATEX_CITE_RE.finditer(content):
        for part in match.group(1).split(","):
            key = part.strip()
            if key:
                found.append(key)
    for match in MD_URL_RE.finditer(content):
        found.append(match.group(1))
    return found


def extract_backtick_anchors(cell: str) -> list[str]:
    return [m.group(1).strip() for m in BACKTICK_RE.finditer(cell) if m.group(1).strip()]


def is_meaningful_anchor(anchor: str) -> bool:
    normalized = anchor.strip()
    if len(normalized) < 4:
        return False
    if re.match(r"^\d+(?:\.\d+)?$", normalized):
        return False
    if normalized.lower() in GENERIC_ANCHORS:
        return False
    return True


def has_ellipsis_truncation(anchor: str) -> bool:
    return "..." in anchor or "…" in anchor


def upstream_tables(root: Path, stage: str) -> list[list[dict]]:
    collected = []
    idx = stage_index(stage)
    for prev in GATE_STAGES[:idx]:
        prev_abs = safe_local(root, PRIMARY_ARTIFACT_BY_STAGE[prev])
        if not prev_abs.is_file():
            continue
        collected.append(parse_markdown_tables(prev_abs.read_text(encoding="utf-8")))
    return collected


def gap_register(history: list[list[dict]]) -> dict[str, dict]:
    gaps = {}
    for tables in history:
        for row in table_rows_by_headers(tables, ["Gap ID", "Description", "Blocking Stage", "Status"]):
            gaps[row["Gap ID"].strip("` ")] = row
        for decision in table_rows_by_headers(tables, ["Decision ID", "Source Type", "Rationale"]):
            for gid in GAP_ID_IN_TEXT_RE.findall(decision.get("Closes", "")):
                if gid in gaps:
                    gaps[gid] = {**gaps[gid], "Status": "closed"}
    return gaps


def referenced_retrievals(content: str, ledger: list[dict]) -> dict:
    # An ID can advance from planned to attempted or satisfied. Only its latest
    # record counts. Existing Markdown tables already contain these same IDs.
    records = {r["id"]: r for r in ledger}
    return {rid: records.get(rid) for rid in sorted(set(RETRIEVAL_ID_RE.findall(content)))}


def audit_stage_ledgers(
    root: Path,
    state: dict,
    stage: str,
    content: str,
    retrievals_ledger: list[dict],
    *,
    require_evidence: bool = False,
    require_claims: bool = False,
    require_implementation_grade_claims: bool = False,
    enforce_full_text_for_body_claims: bool = False,
    check_citations: bool = False,
    upstream_evidence_scopes: dict[str, str] | None = None,
    history: list[list[dict]] | None = None,
) -> dict:
    errors: list[str] = []
    warnings: list[str] = []
    tables = parse_markdown_tables(content)

    unresolved = detect_unfilled_placeholders(content)
    if unresolved:
        errors.append(f"Unfilled template placeholders remain: {', '.join(unresolved[:6])}")

    evidence_rows = table_rows_by_headers(tables, ["Evidence ID", "Source Ref", "Level", "Verbatim Anchor"])
    claim_rows = table_rows_by_headers(tables, ["Claim ID", "Statement", "Evidence IDs", "Level"])
    decision_rows = table_rows_by_headers(tables, ["Decision ID", "Source Type", "Rationale"])
    scenario_rows = table_rows_by_headers(tables, ["Scenario ID", "Criterion", "Status"])

    # 1. Retrieval ledger verification.
    retrievals = referenced_retrievals(content, retrievals_ledger)
    intents = set()
    for rid, record in retrievals.items():
        if record is None:
            errors.append(f"Unknown retrieval {rid}; register the query in the retrieval ledger")
        elif record["status"] in {"attempted", "satisfied"}:
            intents.add(record["intent"])
        elif record["status"] == "not-applicable" and record["intent"] == "venue":
            intents.add("venue")
    required = retrieval_intents_for(stage, state.get("targetVenue"))
    if "counterevidence" in required and intents.isdisjoint(required["counterevidence"]):
        errors.append("Adversarial / counterevidence retrieval is required; cite its RET-* ID")
    if "protocolCalibration" in required and intents.isdisjoint(required["protocolCalibration"]):
        errors.append("RITP retrieval is required for protocol calibration; cite its RET-* ID")

    groups = [*(history or []), tables]
    gap_rows_by_id = gap_register(groups)
    has_venue_gap = any(
        re.search(r"\b(?:venue|cfp|journal|conference|author guide|官网|征稿)\b", row.get("Description", ""), re.I)
        for row in gap_rows_by_id.values()
    )
    if "venueRequirements" in required and intents.isdisjoint(required["venueRequirements"]) and not has_venue_gap:
        errors.append(
            f"Target venue '{state.get('targetVenue')}' requires a venue retrieval record (RET-* with intent=venue) or an explicit venue GAP-*"
        )

    # 2. EVD-* verbatim anchor & read-scope verification.
    evidence_map: dict[str, dict] = {}
    evidence_scopes: dict[str, str] = dict(upstream_evidence_scopes or {})
    if require_evidence and not evidence_rows:
        errors.append(f"Stage '{stage}' requires at least one grounded EVD-* row in the evidence table")

    sources = state.get("sources", {})
    for row in evidence_rows:
        eid = row["Evidence ID"].replace("`", "").strip()
        source_ref = row["Source Ref"].replace("`", "").strip()
        level_raw = row["Level"].replace("`", "").strip()
        location_raw = row.get("Location", "").replace("`", "").strip().lower()
        read_scope_raw = row.get("Read Scope", "").replace("`", "").strip().lower()
        anchor_cell = row.get("Verbatim Anchor", "")
        if not re.match(r"^EVD-[A-Za-z0-9_-]+$", eid):
            errors.append(f"Invalid Evidence ID: {eid or '(empty)'}")
        if level_raw not in EVIDENCE_LEVELS:
            errors.append(f"Invalid evidence level for {eid}: {level_raw}")
            continue

        resolved_scope = "unspecified"
        if read_scope_raw:
            if read_scope_raw not in VALID_READ_SCOPES:
                errors.append(
                    f"Invalid Read Scope '{read_scope_raw}' for {eid}; expected one of: {', '.join(sorted(VALID_READ_SCOPES))}"
                )
            else:
                resolved_scope = read_scope_raw
        elif location_raw in {"abstract", "title/abstract", "abstract-only", "摘要"}:
            resolved_scope = "abstract"
        elif location_raw in {"metadata", "bib", "bibtex"}:
            resolved_scope = "metadata"

        evidence_map[eid] = {"level": level_raw, "sourceRef": source_ref, "readScope": resolved_scope}
        evidence_scopes[eid] = resolved_scope

        if level_raw in {"source-backed", "verified"}:
            anchors = [a for a in extract_backtick_anchors(anchor_cell) if is_meaningful_anchor(a)]
            if not anchors:
                errors.append(f"Evidence {eid} ({level_raw}) must include at least one non-trivial backticked verbatim anchor")
                continue
            if any(has_ellipsis_truncation(a) for a in anchors):
                errors.append(f"Evidence {eid} contains truncated '...' or '…' anchor; supply exact verbatim text")
                continue

            src_ids = SRC_ID_IN_TEXT_RE.findall(source_ref)
            corpus = ""
            if src_ids:
                for sid in src_ids:
                    src = sources.get(sid)
                    if not src:
                        errors.append(f"Evidence {eid} references unregistered source {sid}")
                        continue
                    snap = safe_local(root, src["path"])
                    if not snap.is_file():
                        errors.append(f"Source snapshot missing on disk for {sid}: {src['path']}")
                    else:
                        corpus += "\n" + snap.read_text(encoding="utf-8")
            elif source_ref:
                try:
                    local_file = safe_local(root, source_ref)
                    if local_file.is_file():
                        corpus = local_file.read_text(encoding="utf-8")
                    else:
                        errors.append(f"Evidence {eid} references missing file or unregistered SRC-*: {source_ref}")
                except ValueError:
                    errors.append(f"Evidence {eid} references invalid path outside workspace: {source_ref}")
            else:
                errors.append(f"Evidence {eid} is missing Source Ref")

            if corpus and not any(a in corpus for a in anchors):
                errors.append(f"Evidence {eid} verbatim anchor(s) [{', '.join(anchors)}] not found in {source_ref}")

    # 3. DEC-* decisions.
    known_decisions = {row["Decision ID"].strip("` ") for group in groups
                       for row in table_rows_by_headers(group, ["Decision ID", "Source Type", "Rationale"])}
    for row in decision_rows:
        did = row["Decision ID"].replace("`", "").strip()
        source_type = row["Source Type"].replace("`", "").strip()
        rationale = row["Rationale"].strip()
        if not re.match(r"^DEC-[A-Za-z0-9_-]+$", did):
            errors.append(f"Invalid Decision ID: {did or '(empty)'}")
        if source_type not in {"user-confirmed", "source-backed", "policy-default"}:
            errors.append(
                f"Decision {did} must use source type user-confirmed, source-backed, or policy-default (got: {source_type or 'empty'})"
            )
        if not rationale:
            errors.append(f"Decision {did} is missing rationale")

    # 4. GAP-* blocking closure.
    gaps_open = 0
    gaps_closed = 0
    current_idx = stage_index(stage)
    for row in gap_rows_by_id.values():
        gid = row["Gap ID"].replace("`", "").strip()
        blocking = row["Blocking Stage"].replace("`", "").strip().lower()
        status = row["Status"].replace("`", "").strip().lower()
        if not re.match(r"^GAP-[A-Za-z0-9_-]+$", gid):
            errors.append(f"Invalid Gap ID: {gid or '(empty)'}")
        if status not in {"open", "closed"}:
            errors.append(f"Invalid Gap status for {gid}: {status}")
        if status == "closed":
            gaps_closed += 1
            continue
        gaps_open += 1
        if not blocking:
            continue
        if blocking not in GATE_STAGES:
            errors.append(f"Gap {gid} has unknown Blocking Stage '{blocking}'")
        elif stage_index(blocking) <= current_idx:
            errors.append(
                f"Open blocking gap {gid} blocks stage '{stage}' (blockingStage={blocking}): {row['Description']}"
            )

    # 5. CLM-* claims (with abstract vs full_text scope guard).
    if require_claims and not claim_rows:
        errors.append(f"Stage '{stage}' requires at least one CLM-* claim row")
    for row in claim_rows:
        cid = row["Claim ID"].replace("`", "").strip()
        evd_cell = row.get("Evidence IDs", "")
        level_raw = row["Level"].replace("`", "").strip()
        claim_scope = row.get("Scope", "")
        if not re.match(r"^CLM-[A-Za-z0-9_-]+$", cid):
            errors.append(f"Invalid Claim ID: {cid or '(empty)'}")
        if level_raw not in EVIDENCE_LEVELS:
            errors.append(f"Invalid level for claim {cid}: {level_raw}")
            continue
        if require_implementation_grade_claims and level_raw not in IMPLEMENTATION_GRADE_LEVELS:
            errors.append(
                f"Claim {cid} cannot rely on '{level_raw}' level at stage '{stage}'; ground with verified/source-backed/user-confirmed evidence"
            )
        refs = REF_ID_IN_TEXT_RE.findall(evd_cell)
        if not refs:
            errors.append(f"Claim {cid} must reference at least one EVD-*, SRC-*, or DEC-* ID")
        else:
            evd_refs = [r for r in refs if r.startswith("EVD-")]
            for ref in refs:
                missing_evidence = ref.startswith("EVD-") and ref not in evidence_scopes
                missing_decision = ref.startswith("DEC-") and ref not in known_decisions
                if missing_evidence or missing_decision:
                    findings = errors if require_implementation_grade_claims else warnings
                    findings.append(f"Claim {cid} references undefined {ref}")
                if ref.startswith("SRC-") and ref not in sources:
                    errors.append(f"Claim {cid} references unregistered source {ref}")
            if enforce_full_text_for_body_claims and evd_refs and not NARROW_SCOPE_RE.search(claim_scope):
                known_scopes = [evidence_scopes[r] for r in evd_refs if r in evidence_scopes and evidence_scopes[r] != "unspecified"]
                if known_scopes and all(s in SHALLOW_READ_SCOPES for s in known_scopes):
                    errors.append(
                        f"Claim {cid} relies only on shallow ({'/'.join(sorted(set(known_scopes)))}) evidence ({', '.join(evd_refs)}); "
                        "verify full_text/raw_output or explicitly mark claim Scope as abstract-only"
                    )

    # 6. Citations & URLs membership.
    if check_citations:
        known_members: set[str] = set()
        for src in sources.values():
            known_members.add(src["id"])
            known_members.add(src["identity"])
            known_members.update(src.get("citationKeys", []))
        for citation in citations_in(content):
            if citation not in known_members:
                errors.append(f"Unregistered citation or external link in artifact: {citation}")

    return {
        "errors": errors,
        "warnings": warnings,
        "evidenceScopes": evidence_scopes,
        "counts": {
            "retrievals": len(retrievals),
            "evidence": len(evidence_rows),
            "claims": len(claim_rows),
            "gapsOpen": gaps_open,
            "gapsClosed": gaps_closed,
            "decisions": len(decision_rows),
            "scenarios": len(scenario_rows),
        },
    }
