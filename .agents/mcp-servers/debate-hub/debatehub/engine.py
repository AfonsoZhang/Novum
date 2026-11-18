"""Evidence-anchored multi-agent debate orchestration engine.

Supports three presets:
  * general               — independent pass -> divergence check -> bounded rebuttal -> judge -> human escalation
  * topic_tournament      — pairwise candidate debates + position-swap bias check + Elo ranking -> human topic pack
  * challenge_adjudication — stable challengeId/claimId adversarial check + cross-family judge -> human escalation

Supports both active driving (CLI / ACP / MCP / HTTP adapters) and passive board
participation (external MCP agents joining via board tools), or a hybrid mix.
"""
from __future__ import annotations

import concurrent.futures
import itertools
import json
import random
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from .adapters import CallResult, make_adapter, observed_family
from .config import availability, infer_family
from .evidence import (
    build_inline_materials,
    check_artifact_staleness,
    extract_json_object,
    snapshot_artifacts,
    verify_quotes_list,
)
from .store import SessionStore, new_session_id, utc_now

PRESETS = {"general", "topic_tournament", "challenge_adjudication"}
ROLES = {"debater", "judge", "observer"}
ProgressFn = Callable[[str, int, int], None]


class DebateError(ValueError):
    pass


# ── Prompt builders ──────────────────────────────────────────────────────

def _materials_section(session: Dict[str, Any], inline: bool, max_inline_bytes: int) -> str:
    artifacts = session.get("artifacts") or []
    if not artifacts:
        return "Primary artifacts: (none attached)."
    if inline:
        return "Primary artifacts (bounded raw excerpts):\n\n" + build_inline_materials(artifacts, max_inline_bytes)
    lines = ["Primary artifacts to read directly from disk (do NOT rely on summaries):"]
    for art in artifacts:
        lines.append(f"- {art['path']} (display: {art['displayPath']}, sha256: {art['sha256'][:12]})")
    return "\n".join(lines)


def _format_verified_entry(label: str, entry: Dict[str, Any]) -> str:
    lines = [f"### {label} (verdict: {entry.get('verdict')}, confidence: {entry.get('confidence')})"]
    if entry.get("side"):
        lines.append(f"Role/Side: {entry['side']}")
    if entry.get("summary"):
        lines.append(f"Summary: {entry['summary']}")
    for arg in entry.get("arguments") or []:
        lines.append(f"- Argument: {arg}")
    quotes = (entry.get("quoteSummary") or {}).get("quotes") or []
    if quotes:
        lines.append("Evidence quotes:")
        for q in quotes:
            tag = (f"[VERIFIED {q.get('matchKind')} L{q.get('matchedLine')}]"
                   if q.get("verified") else f"[UNVERIFIED QUOTE ({q.get('matchKind')}) - DO NOT TRUST]")
            lines.append(f"  * {tag} {q.get('path')}: \"{q.get('quote')}\"")
    else:
        lines.append("Evidence quotes: [NONE — UNANCHORED]")
    if entry.get("crux"):
        lines.append(f"Crux: {entry['crux']}")
    if entry.get("decisiveEvidence"):
        lines.append(f"Decisive evidence needed: {entry['decisiveEvidence']}")
    return "\n".join(lines)


def _build_independent_prompt(session: Dict[str, Any], side: Optional[str],
                              inline: bool, max_inline_bytes: int) -> str:
    preset = session["preset"]
    parts = [
        "INDEPENDENT ASSESSMENT (Phase 1 — no peer outputs have been shared).",
        "Read the primary artifacts directly. Every factual claim MUST be backed by a verbatim "
        "quote from a primary artifact file with its exact file path. Unverified quotes will be "
        "flagged and downgraded.",
        "",
        f"Title: {session.get('title', '')}",
        f"Question / Objective: {session.get('question', '')}",
    ]
    if session.get("criteria"):
        parts.append("Evaluation criteria:\n" + "\n".join(f"- {c}" for c in session["criteria"]))
    if preset == "challenge_adjudication":
        ch = session.get("challenge") or {}
        parts += [
            "",
            f"Challenge ID: {ch.get('challengeId')}",
            f"Claim ID: {ch.get('claimId')}",
            f"Severity: {ch.get('severity', 'major')}",
            f"Claim under review: {ch.get('claimText', '')}",
            f"Challenge raised: {ch.get('challengeDescription', '')}",
        ]
        if side == "defender":
            parts.append("Your assigned stance: DEFENDER — inspect the primary artifacts and determine whether "
                         "verifiable evidence resolves this challenge or bounds it as an admissible limitation.")
        elif side == "critic":
            parts.append("Your assigned stance: CRITIC — inspect the primary artifacts independently and test "
                         "whether the claim holds up or remains broken/unsupported.")
        verdict_opts = '"RESOLVED" | "UNRESOLVED" | "ADMISSIBLE_LIMITATION" | "UNCERTAIN"'
    else:
        if side:
            parts.append(f"Assigned perspective: {side}")
        verdict_opts = '"SUPPORT" | "OPPOSE" | "PASS" | "FAIL" | "BLOCKED" | "UNCERTAIN"'

    parts += [
        "",
        _materials_section(session, inline, max_inline_bytes),
        "",
        "Return ONLY a valid JSON object (wrapped in ```json ... ```) with this schema:",
        "{",
        f'  "verdict": {verdict_opts},',
        '  "confidence": 0.0 to 1.0,',
        '  "summary": "concise independent assessment",',
        '  "arguments": ["key point 1", "key point 2"],',
        '  "quotes": [{"path": "path/to/file", "quote": "exact verbatim substring from file", "line": 12}],',
        '  "crux": "the core question or assumption that decides this issue",',
        '  "decisiveEvidence": "what concrete evidence or check would settle any remaining doubt"',
        "}",
    ]
    return "\n".join(parts)


def _build_rebuttal_prompt(session: Dict[str, Any], round_num: int, self_id: str,
                           peer_entries: List[Dict[str, Any]], inline: bool, max_inline_bytes: int) -> str:
    parts = [
        f"CONSTRAINED REBUTTAL (Round {round_num}).",
        "Independent assessments diverged. Respond ONLY to concrete factual/methodological points "
        "using verbatim quotes from primary artifacts. Do NOT defer to peers without evidence; "
        "do NOT rely on any quote marked [UNVERIFIED QUOTE].",
        "",
        f"Question / Objective: {session.get('question', '')}",
    ]
    if session["preset"] == "challenge_adjudication":
        ch = session.get("challenge") or {}
        parts.append(f"Challenge {ch.get('challengeId')} on Claim {ch.get('claimId')}: {ch.get('challengeDescription')}")
        verdict_opts = '"RESOLVED" | "UNRESOLVED" | "ADMISSIBLE_LIMITATION" | "UNCERTAIN"'
    else:
        verdict_opts = '"SUPPORT" | "OPPOSE" | "PASS" | "FAIL" | "BLOCKED" | "UNCERTAIN"'

    parts += ["", "Prior positions (anonymized):"]
    for idx, entry in enumerate(peer_entries):
        tag = f"Your previous position" if entry.get("agentId") == self_id else f"Peer {chr(65 + idx)}"
        parts.append(_format_verified_entry(tag, entry))
        parts.append("")

    parts += [
        _materials_section(session, inline, max_inline_bytes),
        "",
        "Return ONLY a valid JSON object (wrapped in ```json ... ```):",
        "{",
        f'  "verdict": {verdict_opts},',
        '  "confidence": 0.0 to 1.0,',
        '  "summary": "updated position addressing peer arguments directly",',
        '  "arguments": ["rebuttal or concession with reasoning"],',
        '  "quotes": [{"path": "path/to/file", "quote": "exact verbatim substring", "line": 12}],',
        '  "crux": "remaining core point of disagreement (or agreement)",',
        '  "decisiveEvidence": "what single test/source would decisively settle this"',
        "}",
    ]
    return "\n".join(parts)


def _build_judge_prompt(session: Dict[str, Any], ordered_entries: List[Tuple[str, Dict[str, Any]]],
                        inline: bool, max_inline_bytes: int) -> str:
    is_challenge = session["preset"] == "challenge_adjudication"
    verdict_opts = ('"RESOLVED" | "UNRESOLVED" | "ADMISSIBLE_LIMITATION" | "ESCALATE_HUMAN"'
                    if is_challenge else '"SUPPORT" | "OPPOSE" | "PASS" | "FAIL" | "BLOCKED" | "ESCALATE_HUMAN"')
    parts = [
        "INDEPENDENT JUDGE ADJUDICATION.",
        "You are an independent judge (not a debater). Verify the debaters' claims directly against "
        "the primary artifacts. Treat arguments with [UNVERIFIED QUOTE] or [NONE — UNANCHORED] as "
        "unsupported and downgrade them. Do NOT reward rhetoric over primary evidence.",
        "If the dispute turns on a subjective value judgment (research taste, venue choice, scope "
        "preference, ethics) or the evidence is genuinely inconclusive, set needsHuman=true.",
        "",
        f"Title: {session.get('title', '')}",
        f"Question / Objective: {session.get('question', '')}",
    ]
    if is_challenge:
        ch = session.get("challenge") or {}
        parts += [
            f"Challenge ID: {ch.get('challengeId')} (severity: {ch.get('severity')})",
            f"Claim ID: {ch.get('claimId')}: {ch.get('claimText')}",
            f"Challenge: {ch.get('challengeDescription')}",
        ]
    parts += ["", "Debate record (anonymized, presentation order randomized):"]
    for label, entry in ordered_entries:
        parts.append(_format_verified_entry(label, entry))
        parts.append("")
    parts += [
        _materials_section(session, inline, max_inline_bytes),
        "",
        "Return ONLY a valid JSON object (wrapped in ```json ... ```):",
        "{",
        f'  "verdict": {verdict_opts},',
        '  "confidence": 0.0 to 1.0,',
        '  "summary": "evidence-grounded ruling",',
        '  "coreCrux": "single sharpest point separating the sides",',
        '  "winningArguments": ["verified point that settled or dominates the issue"],',
        '  "quotes": [{"path": "path/to/file", "quote": "exact verbatim substring you verified", "line": 12}],',
        '  "decisiveEvidence": "what additional experiment/source would change or finalize this ruling",',
        '  "valueJudgment": true or false,',
        '  "needsHuman": true or false,',
        '  "needsHumanReason": "why human judgment is or is not needed"',
        "}",
    ]
    return "\n".join(parts)


def _build_advocate_prompt(session: Dict[str, Any], mine: Dict[str, Any], rival: Dict[str, Any],
                           inline: bool, max_inline_bytes: int) -> str:
    parts = [
        "TOPIC TOURNAMENT — CANDIDATE ADVOCATE.",
        "Make the strongest honest, evidence-anchored case for your assigned candidate compared "
        "against the rival candidate, and identify the sharpest risk/weakness of both. "
        "Do NOT invent citations or results; ground claims in primary artifacts with verbatim quotes.",
        "",
        f"Research objective: {session.get('question', '')}",
    ]
    if session.get("criteria"):
        parts.append("Selection criteria:\n" + "\n".join(f"- {c}" for c in session["criteria"]))
    parts += [
        "",
        f"YOUR CANDIDATE ({mine['id']}): {mine['title']}\n{mine.get('summary', '')}",
        "",
        f"RIVAL CANDIDATE ({rival['id']}): {rival['title']}\n{rival.get('summary', '')}",
        "",
        _materials_section(session, inline, max_inline_bytes),
        "",
        "Return ONLY a valid JSON object (wrapped in ```json ... ```):",
        "{",
        '  "summary": "core thesis for why your candidate beats the rival",',
        '  "arguments": ["strength 1 vs rival", "strength 2 vs rival"],',
        '  "rivalWeaknesses": ["concrete weakness or risk of rival"],',
        '  "ownRisks": ["honest major risk of your own candidate"],',
        '  "quotes": [{"path": "path/to/file", "quote": "exact verbatim substring", "line": 12}],',
        '  "decisiveEvidence": "minimal pilot or literature check that separates these two ideas"',
        "}",
    ]
    return "\n".join(parts)


def _build_tournament_judge_prompt(session: Dict[str, Any], first_cand: Dict[str, Any],
                                   second_cand: Dict[str, Any], first_adv: Dict[str, Any],
                                   second_adv: Dict[str, Any], inline: bool, max_inline_bytes: int) -> str:
    parts = [
        "TOPIC TOURNAMENT — PAIRWISE JUDGE.",
        "Compare Option 1 and Option 2 on scientific novelty, value, evidence/grounding, and feasibility. "
        "Discount any claim backed only by [UNVERIFIED QUOTE]. Note that a human will make the final "
        "topic approval decision; your job is an honest pairwise comparison and clear crux.",
        "",
        f"Research objective: {session.get('question', '')}",
    ]
    if session.get("criteria"):
        parts.append("Criteria:\n" + "\n".join(f"- {c}" for c in session["criteria"]))
    parts += [
        "",
        f"=== OPTION 1: {first_cand['title']} ===",
        first_cand.get("summary", ""),
        _format_verified_entry("Advocate for Option 1", first_adv),
        "",
        f"=== OPTION 2: {second_cand['title']} ===",
        second_cand.get("summary", ""),
        _format_verified_entry("Advocate for Option 2", second_adv),
        "",
        _materials_section(session, inline, max_inline_bytes),
        "",
        "Return ONLY a valid JSON object (wrapped in ```json ... ```):",
        "{",
        '  "winner": "OPTION_1" | "OPTION_2" | "DRAW",',
        '  "confidence": 0.0 to 1.0,',
        '  "summary": "why the winner is stronger or why they tie",',
        '  "coreCrux": "main trade-off between Option 1 and Option 2",',
        '  "decisiveEvidence": "cheapest check to decisively separate them",',
        '  "quotes": [{"path": "path/to/file", "quote": "exact verbatim substring", "line": 12}]',
        "}",
    ]
    return "\n".join(parts)


# ── Helpers ──────────────────────────────────────────────────────────────

def _clamp_conf(val: Any) -> Optional[float]:
    try:
        f = float(val)
    except (TypeError, ValueError):
        return None
    return max(0.0, min(1.0, round(f, 3)))


def _parse_entry(agent_id: str, role: str, phase: str, round_num: int, side: Optional[str],
                 model: str, family: str, call: CallResult, allowed_roots: List[str],
                 cwd: str, registered_paths: set[str]) -> Dict[str, Any]:
    entry_id = f"E-{uuid.uuid4().hex[:8]}"
    base: Dict[str, Any] = {
        "entryId": entry_id,
        "createdAt": utc_now(),
        "phase": phase,
        "round": round_num,
        "agentId": agent_id,
        "role": role,
        "side": side,
        "model": model,
        "family": family,
        "meta": call.meta,
    }
    if not call.ok:
        base.update(status="error", error=call.error or "agent call failed", verdict="ERROR",
                    confidence=None, summary="", arguments=[],
                    quoteSummary={"quotes": [], "totalCount": 0, "verifiedCount": 0,
                                  "unverifiedCount": 0, "hasVerifiedAnchor": False},
                    rawText="")
        return base

    parsed = extract_json_object(call.text)
    if not parsed:
        base.update(status="error", error="agent response was not parseable JSON",
                    verdict="ERROR", confidence=None, summary=call.text.strip()[:500],
                    arguments=[],
                    quoteSummary={"quotes": [], "totalCount": 0, "verifiedCount": 0,
                                  "unverifiedCount": 0, "hasVerifiedAnchor": False},
                    rawText=call.text[:12000])
        return base

    qs = verify_quotes_list(parsed.get("quotes"), allowed_roots, cwd, registered_paths)
    verdict = str(parsed.get("verdict") or parsed.get("winner") or "UNCERTAIN").strip().upper()
    args = parsed.get("arguments")
    args_list = [str(a) for a in args] if isinstance(args, list) else []
    base.update(
        status="ok",
        error=None,
        verdict=verdict,
        confidence=_clamp_conf(parsed.get("confidence")),
        summary=str(parsed.get("summary") or "").strip(),
        arguments=args_list,
        rivalWeaknesses=[str(x) for x in parsed.get("rivalWeaknesses") or []]
        if isinstance(parsed.get("rivalWeaknesses"), list) else [],
        ownRisks=[str(x) for x in parsed.get("ownRisks") or []]
        if isinstance(parsed.get("ownRisks"), list) else [],
        winningArguments=[str(x) for x in parsed.get("winningArguments") or []]
        if isinstance(parsed.get("winningArguments"), list) else [],
        quoteSummary=qs,
        crux=str(parsed.get("coreCrux") or parsed.get("crux") or "").strip(),
        decisiveEvidence=str(parsed.get("decisiveEvidence") or "").strip(),
        valueJudgment=bool(parsed.get("valueJudgment", False)),
        needsHuman=bool(parsed.get("needsHuman", False)),
        needsHumanReason=str(parsed.get("needsHumanReason") or "").strip(),
        rawText=call.text[:12000],
    )
    return base


def _compute_independence(session: Dict[str, Any]) -> Dict[str, Any]:
    deb_fams: set[str] = set()
    judge_fams: set[str] = set()
    for e in session.get("entries") or []:
        if e.get("status") != "ok":
            continue
        fam = e.get("family") or "unknown"
        if e.get("role") == "debater":
            deb_fams.add(fam)
        elif e.get("role") == "judge":
            judge_fams.add(fam)
    for m in session.get("matches") or []:
        for k in ("forwardJudge", "swappedJudge"):
            j = m.get(k) or {}
            if j.get("status") == "ok":
                judge_fams.add(j.get("family") or "unknown")
        for k in ("advocateA", "advocateB"):
            a = m.get(k) or {}
            if a.get("status") == "ok":
                deb_fams.add(a.get("family") or "unknown")

    known_deb = {f for f in deb_fams if f != "unknown"}
    known_judge = {f for f in judge_fams if f != "unknown"}
    exec_fam = session.get("executorFamily")
    warnings: List[str] = []
    cross_deb = len(known_deb) >= 2
    if deb_fams and not cross_deb:
        warnings.append("Debaters are not verified cross-family (homogeneous debate has limited gains over voting).")
    cross_judge = bool(known_judge) and not (known_judge & known_deb)
    if exec_fam and exec_fam in known_judge:
        cross_judge = False
        warnings.append(f"Judge family overlaps with executorFamily ({exec_fam}).")
    elif judge_fams and not cross_judge:
        warnings.append("Judge family overlaps with debaters or is unknown (same-family independence limitation).")
    if "unknown" in deb_fams or "unknown" in judge_fams:
        warnings.append("At least one participant has unknown model family.")
    return {
        "debaterFamilies": sorted(deb_fams),
        "judgeFamilies": sorted(judge_fams),
        "executorFamily": exec_fam,
        "crossFamilyDebaters": cross_deb,
        "crossFamilyJudge": cross_judge,
        "warnings": warnings,
    }


def _check_divergence(entries: List[Dict[str, Any]], force_debate: bool = False) -> Dict[str, Any]:
    ok = [e for e in entries if e.get("status") == "ok"]
    verdicts = {e["agentId"]: e.get("verdict") for e in ok}
    unique = set(verdicts.values())
    if force_debate:
        return {"checked": True, "divergent": True, "verdicts": verdicts, "reason": "forceDebate requested"}
    if len(ok) < 2:
        return {"checked": True, "divergent": False, "verdicts": verdicts,
                "reason": "fewer than two valid independent debater assessments"}
    if len(unique) > 1:
        return {"checked": True, "divergent": True, "verdicts": verdicts,
                "reason": f"independent verdicts diverged: {sorted(unique)}"}
    if any(v in ("UNCERTAIN", "ESCALATE_HUMAN", "BLOCKED") for v in unique):
        return {"checked": True, "divergent": True, "verdicts": verdicts,
                "reason": f"independent assessment is non-decisive ({sorted(unique)})"}
    return {"checked": True, "divergent": False, "verdicts": verdicts,
            "reason": f"all {len(ok)} independent assessments agreed on {next(iter(unique))}"}


def _elo_expected(ra: float, rb: float) -> float:
    return 1.0 / (1.0 + 10.0 ** ((rb - ra) / 400.0))


def _update_elo(ra: float, rb: float, score_a: float, k: float = 32.0) -> Tuple[float, float, float, float]:
    ea = _elo_expected(ra, rb)
    da = round(k * (score_a - ea), 2)
    db = round(-da, 2)
    return round(ra + da, 2), round(rb + db, 2), da, db


def _build_decision_brief(session: Dict[str, Any]) -> Dict[str, Any]:
    """Build a debiased, evidence-anchored brief for human review.

    Sides are ordered with a deterministic seed stored on the session; AI judge
    tendency is placed under a separate `aiRecommendation` key so the UI keeps
    it folded until the human is ready.
    """
    seed = session.get("briefSeed")
    if seed is None:
        seed = random.SystemRandom().randint(1, 2**31 - 1)
        session["briefSeed"] = seed
    rng = random.Random(seed)
    staleness = check_artifact_staleness(session.get("artifacts") or [])

    if session["preset"] == "topic_tournament":
        ranked = sorted(session.get("candidates") or [], key=lambda c: c.get("elo", 1500.0), reverse=True)
        # Keep display order randomized for blind human pass, while preserving Elo table under aiRecommendation
        display_cands = list(ranked)
        rng.shuffle(display_cands)
        cards: List[Dict[str, Any]] = []
        for idx, cand in enumerate(display_cands, 1):
            cid = cand["id"]
            pro_quotes: List[Dict[str, Any]] = []
            pros: List[str] = []
            cons: List[str] = []
            checks: List[str] = []
            for m in session.get("matches") or []:
                for key, other_key in (("candidateA", "advocateA"), ("candidateB", "advocateB")):
                    if m.get(key) == cid:
                        adv = m.get(other_key) or {}
                        pros.extend(adv.get("arguments") or [])
                        cons.extend(adv.get("ownRisks") or [])
                        pro_quotes.extend((adv.get("quoteSummary") or {}).get("quotes") or [])
                        if adv.get("decisiveEvidence"):
                            checks.append(adv["decisiveEvidence"])
                    elif m.get(key) != cid:
                        adv = m.get(other_key) or {}
                        cons.extend(adv.get("rivalWeaknesses") or [])
            cards.append({
                "displayLabel": f"Candidate {chr(64 + idx)}",
                "candidateId": cid,
                "title": cand.get("title"),
                "summary": cand.get("summary"),
                "strongestPros": list(dict.fromkeys(pros))[:5],
                "strongestCons": list(dict.fromkeys(cons))[:5],
                "quotes": pro_quotes[:8],
                "decisiveChecks": list(dict.fromkeys(checks))[:3],
            })
        inconsistent = [m["matchId"] for m in session.get("matches") or [] if m.get("winner") == "position_inconsistent"]
        return {
            "seed": seed,
            "kind": "topic_tournament",
            "title": session.get("title"),
            "question": session.get("question"),
            "artifacts": session.get("artifacts") or [],
            "artifactStaleness": staleness,
            "candidatesBlindOrder": cards,
            "matches": [
                {
                    "matchId": m["matchId"],
                    "candidateA": m["candidateA"],
                    "candidateB": m["candidateB"],
                    "crux": m.get("crux"),
                    "decisiveEvidence": m.get("decisiveEvidence"),
                    "positionConsistent": m.get("positionConsistent"),
                }
                for m in session.get("matches") or []
            ],
            "positionInconsistentMatches": inconsistent,
            "aiRecommendation": {
                "rankedCandidates": [
                    {
                        "candidateId": c["id"], "title": c["title"], "elo": c.get("elo", 1500.0),
                        "wins": c.get("wins", 0), "losses": c.get("losses", 0),
                        "draws": c.get("draws", 0), "inconsistent": c.get("inconsistent", 0),
                    }
                    for c in ranked
                ],
                "escalationReasons": (session.get("aiOutcome") or {}).get("escalationReasons") or [],
                "independence": session.get("independenceReport") or {},
            },
        }

    # general or challenge_adjudication
    latest_by_debater: Dict[str, Dict[str, Any]] = {}
    for e in session.get("entries") or []:
        if e.get("role") == "debater" and e.get("status") == "ok":
            latest_by_debater[e["agentId"]] = e
    positions = list(latest_by_debater.values())
    rng.shuffle(positions)
    sides: List[Dict[str, Any]] = []
    for idx, pos in enumerate(positions, 1):
        qs = pos.get("quoteSummary") or {}
        sides.append({
            "displayLabel": f"Position {chr(64 + idx)}",
            "verdict": pos.get("verdict"),
            "side": pos.get("side"),
            "summary": pos.get("summary"),
            "arguments": pos.get("arguments") or [],
            "quotes": qs.get("quotes") or [],
            "verifiedQuoteCount": qs.get("verifiedCount", 0),
            "unverifiedQuoteCount": qs.get("unverifiedCount", 0),
            "downgradedUnanchored": not qs.get("hasVerifiedAnchor", False),
            "crux": pos.get("crux"),
            "decisiveEvidence": pos.get("decisiveEvidence"),
        })

    judges = [e for e in session.get("entries") or [] if e.get("role") == "judge" and e.get("status") == "ok"]
    ai_out = session.get("aiOutcome") or {}
    core_crux = ai_out.get("coreCrux") or next((s["crux"] for s in sides if s.get("crux")), "")
    decisive = ai_out.get("decisiveEvidence") or next(
        (s["decisiveEvidence"] for s in sides if s.get("decisiveEvidence")), "")
    return {
        "seed": seed,
        "kind": session["preset"],
        "title": session.get("title"),
        "question": session.get("question"),
        "challenge": session.get("challenge"),
        "artifacts": session.get("artifacts") or [],
        "artifactStaleness": staleness,
        "positionsBlindOrder": sides,
        "coreCrux": core_crux,
        "decisiveEvidence": decisive,
        "aiRecommendation": {
            "verdict": ai_out.get("verdict"),
            "confidence": ai_out.get("confidence"),
            "resolutionKind": ai_out.get("resolutionKind"),
            "escalationReasons": ai_out.get("escalationReasons") or [],
            "judges": [
                {
                    "agentId": j["agentId"], "family": j.get("family"), "verdict": j.get("verdict"),
                    "confidence": j.get("confidence"), "summary": j.get("summary"),
                    "needsHuman": j.get("needsHuman"), "needsHumanReason": j.get("needsHumanReason"),
                    "valueJudgment": j.get("valueJudgment"),
                    "verifiedQuoteCount": (j.get("quoteSummary") or {}).get("verifiedCount", 0),
                }
                for j in judges
            ],
            "independence": session.get("independenceReport") or {},
        },
    }


# ── Engine ───────────────────────────────────────────────────────────────

class DebateEngine:
    def __init__(self, cfg: Dict[str, Any], store: Optional[SessionStore] = None,
                 adapter_factory: Callable[[Dict[str, Any], float], Any] = make_adapter):
        self.cfg = cfg
        self.store = store or SessionStore(cfg["storeDir"])
        self.adapter_factory = adapter_factory
        self._budget_lock = threading.Lock()

    def _resolve_participant(self, agent_id: str, role: str, side: Optional[str] = None) -> Dict[str, Any]:
        agents = self.cfg.get("agents") or {}
        if agent_id in agents:
            spec = agents[agent_id]
            mode = "external" if spec["kind"] == "external" else "driven"
            return {
                "agentId": agent_id,
                "role": role,
                "mode": mode,
                "model": spec.get("model") or "",
                "family": spec.get("family") or "unknown",
                "side": side,
                "joinedAt": utc_now(),
            }
        # Allow registering a planned external board slot even if not pre-declared in config
        return {
            "agentId": agent_id,
            "role": role,
            "mode": "external",
            "model": "",
            "family": "unknown",
            "side": side,
            "joinedAt": utc_now(),
        }

    def create_session(self, params: Dict[str, Any]) -> Dict[str, Any]:
        preset = str(params.get("preset") or "general")
        if preset not in PRESETS:
            raise DebateError(f"preset must be one of {sorted(PRESETS)}")
        title = str(params.get("title") or "").strip()
        question = str(params.get("question") or "").strip()
        if not question:
            raise DebateError("question is required")
        root = self.cfg["root"]
        cwd_raw = params.get("cwd") or root
        cwd_path = Path(cwd_raw).resolve()
        allowed_roots = self.cfg["allowedRoots"]
        if not any(self._is_under(cwd_path, Path(r).resolve()) for r in allowed_roots):
            raise DebateError(f"cwd escapes allowedRoots: {cwd_raw}")
        if not cwd_path.is_dir():
            raise DebateError(f"cwd does not exist: {cwd_raw}")

        artifact_paths = list(params.get("artifacts") or [])
        artifacts = snapshot_artifacts(artifact_paths, allowed_roots, str(cwd_path))

        defaults = self.cfg["defaults"]
        budget = {
            "maxCalls": max(1, int(params.get("maxCalls") or defaults["maxCalls"])),
            "callsUsed": 0,
            "maxRounds": max(0, int(params.get("maxRounds") if params.get("maxRounds") is not None
                                    else defaults["maxRounds"])),
            "maxParallel": max(1, int(params.get("maxParallel") or defaults["maxParallel"])),
            "maxMatches": max(1, int(params.get("maxMatches") or defaults["maxMatches"])),
            "timeoutSeconds": float(params.get("timeoutSeconds") or defaults["timeoutSeconds"]),
            "elapsedSeconds": 0.0,
            "escalateBelowConfidence": float(params.get("escalateBelowConfidence")
                                             if params.get("escalateBelowConfidence") is not None
                                             else defaults["escalateBelowConfidence"]),
            "swapPositions": bool(params.get("swapPositions", True)),
            "maxInlineBytes": int(params.get("maxInlineBytes") or defaults["maxInlineBytes"]),
        }

        participants: Dict[str, Dict[str, Any]] = {}
        debaters = list(params.get("debaters") or [])
        judges = list(params.get("judges") or [])
        sides = params.get("sides") or {}
        for d in debaters:
            if not isinstance(d, str) or not d.strip():
                raise DebateError("each debater id must be a non-empty string")
            participants[d] = self._resolve_participant(d, "debater", sides.get(d))
        for j in judges:
            if not isinstance(j, str) or not j.strip():
                raise DebateError("each judge id must be a non-empty string")
            if j in participants:
                raise DebateError(f"agent {j!r} cannot be both debater and judge in the same session")
            participants[j] = self._resolve_participant(j, "judge")

        challenge = None
        if preset == "challenge_adjudication":
            ch_raw = params.get("challenge") or {}
            cid = str(ch_raw.get("challengeId") or "").strip()
            claim_id = str(ch_raw.get("claimId") or "").strip()
            desc = str(ch_raw.get("challengeDescription") or question).strip()
            if not cid or not claim_id:
                raise DebateError("challenge_adjudication requires challenge.challengeId and challenge.claimId")
            sev = str(ch_raw.get("severity") or "major").lower()
            if sev not in ("critical", "major", "minor"):
                raise DebateError("challenge.severity must be critical, major, or minor")
            challenge = {
                "challengeId": cid,
                "claimId": claim_id,
                "claimText": str(ch_raw.get("claimText") or "").strip(),
                "challengeDescription": desc,
                "severity": sev,
                "defenderRebuttal": ch_raw.get("defenderRebuttal"),
            }
            # Assign default defender/critic stances if two debaters and no sides passed
            deb_ids = [pid for pid, p in participants.items() if p["role"] == "debater"]
            if len(deb_ids) >= 2 and not any(participants[pid].get("side") for pid in deb_ids):
                participants[deb_ids[0]]["side"] = "defender"
                participants[deb_ids[1]]["side"] = "critic"

        candidates: List[Dict[str, Any]] = []
        if preset == "topic_tournament":
            raw_cands = params.get("candidates") or []
            if len(raw_cands) < 2:
                raise DebateError("topic_tournament requires at least 2 candidates")
            seen_ids: set[str] = set()
            for idx, c in enumerate(raw_cands, 1):
                if not isinstance(c, dict) or not str(c.get("title") or "").strip():
                    raise DebateError(f"candidate #{idx} must be an object with a title")
                cid = str(c.get("id") or f"cand-{idx}").strip()
                if cid in seen_ids:
                    raise DebateError(f"duplicate candidate id: {cid}")
                seen_ids.add(cid)
                candidates.append({
                    "id": cid,
                    "title": str(c["title"]).strip(),
                    "summary": str(c.get("summary") or "").strip(),
                    "elo": 1500.0, "wins": 0, "losses": 0, "draws": 0, "inconsistent": 0,
                })

        exec_fam = params.get("executorFamily") or infer_family(params.get("executorModel"))
        sid = str(params.get("sessionId") or new_session_id(preset[:3]))
        session: Dict[str, Any] = {
            "version": 1,
            "sessionId": sid,
            "preset": preset,
            "title": title or question[:80],
            "question": question,
            "criteria": [str(c) for c in (params.get("criteria") or [])],
            "cwd": str(cwd_path),
            "artifacts": artifacts,
            "requireHumanApproval": True if preset == "topic_tournament" else bool(params.get("requireHumanApproval", False)),
            "executorFamily": exec_fam,
            "challenge": challenge,
            "candidates": candidates,
            "participants": participants,
            "budget": budget,
            "status": "open",
            "phase": "tournament" if preset == "topic_tournament" else "independent",
            "round": 0,
            "entries": [],
            "matches": [],
            "divergence": {"checked": False, "divergent": None, "verdicts": {}, "reason": ""},
            "independenceReport": {},
            "aiOutcome": None,
            "decisionBrief": None,
            "humanDecision": None,
            "card": None,
            "briefSeed": random.SystemRandom().randint(1, 2**31 - 1),
            "createdAt": utc_now(),
            "updatedAt": utc_now(),
        }

        # If challenge_adjudication includes a pre-supplied executor rebuttal, anchor-verify it immediately
        if challenge and isinstance(challenge.get("defenderRebuttal"), dict):
            reb = challenge["defenderRebuttal"]
            reg = {a["path"] for a in artifacts}
            qs = verify_quotes_list(reb.get("quotes"), allowed_roots, str(cwd_path), reg)
            session["entries"].append({
                "entryId": f"E-{uuid.uuid4().hex[:8]}",
                "createdAt": utc_now(),
                "phase": "independent",
                "round": 0,
                "agentId": "executor-rebuttal",
                "role": "debater",
                "side": "defender",
                "model": str(params.get("executorModel") or "executor"),
                "family": exec_fam or "unknown",
                "status": "ok",
                "error": None,
                "verdict": str(reb.get("verdict") or "RESOLVED").upper(),
                "confidence": _clamp_conf(reb.get("confidence")),
                "summary": str(reb.get("summary") or "").strip(),
                "arguments": [str(a) for a in reb.get("arguments") or []]
                if isinstance(reb.get("arguments"), list) else [],
                "quoteSummary": qs,
                "crux": str(reb.get("crux") or "").strip(),
                "decisiveEvidence": str(reb.get("decisiveEvidence") or "").strip(),
                "valueJudgment": False,
                "needsHuman": False,
                "needsHumanReason": "",
                "rawText": "",
                "meta": {"suppliedByExecutor": True},
            })

        return self.store.create(session)

    @staticmethod
    def _is_under(path: Path, root: Path) -> bool:
        try:
            path.relative_to(root)
            return True
        except ValueError:
            return False

    # ── Open Board (external MCP agents) ─────────────────────────────────

    def board_join(self, session_id: str, agent_id: str, role: str = "debater",
                   model: str = "", family: str = "", side: Optional[str] = None) -> Dict[str, Any]:
        if role not in ROLES:
            raise DebateError(f"role must be one of {sorted(ROLES)}")
        if not agent_id or not isinstance(agent_id, str):
            raise DebateError("agentId is required")
        fam = family or infer_family(model) or "unknown"

        def mutate(s: Dict[str, Any]) -> Dict[str, Any]:
            existing = s["participants"].get(agent_id)
            if existing and existing["role"] != role and existing["role"] in ("debater", "judge"):
                raise DebateError(f"agent {agent_id!r} already joined as {existing['role']}")
            s["participants"][agent_id] = {
                "agentId": agent_id,
                "role": role,
                "mode": existing["mode"] if existing else "external",
                "model": model or (existing or {}).get("model", ""),
                "family": fam if fam != "unknown" else (existing or {}).get("family", "unknown"),
                "side": side or (existing or {}).get("side"),
                "joinedAt": (existing or {}).get("joinedAt") or utc_now(),
            }
            return s["participants"][agent_id]

        part = self.store.update(session_id, mutate)
        return {"sessionId": session_id, "participant": part}

    def board_read(self, session_id: str, requester_id: Optional[str] = None) -> Dict[str, Any]:
        s = self.store.load(session_id)
        entries = list(s.get("entries") or [])
        hidden_count = 0
        independence_filter_applied = False

        # Anti-contamination guard: hide other debaters' independent entries until
        # requester posts their own independent entry (or session leaves independent phase).
        part = s["participants"].get(requester_id or "") if requester_id else None
        is_debater = bool(part and part.get("role") == "debater")
        if is_debater and s.get("phase") == "independent":
            posted_self = any(
                e.get("agentId") == requester_id and e.get("phase") == "independent" and e.get("status") == "ok"
                for e in entries
            )
            if not posted_self:
                visible = []
                for e in entries:
                    if e.get("role") == "debater" and e.get("phase") == "independent" and e.get("agentId") != requester_id:
                        hidden_count += 1
                    else:
                        visible.append(e)
                entries = visible
                independence_filter_applied = True

        return {
            "sessionId": s["sessionId"],
            "preset": s["preset"],
            "title": s["title"],
            "question": s["question"],
            "criteria": s.get("criteria") or [],
            "challenge": s.get("challenge"),
            "candidates": s.get("candidates") or [],
            "cwd": s["cwd"],
            "artifacts": s["artifacts"],
            "artifactStaleness": check_artifact_staleness(s["artifacts"]),
            "status": s["status"],
            "phase": s["phase"],
            "round": s["round"],
            "participants": s["participants"],
            "independenceFilterApplied": independence_filter_applied,
            "hiddenIndependentEntries": hidden_count,
            "entries": entries,
            "divergence": s.get("divergence"),
            "aiOutcome": s.get("aiOutcome"),
            "humanDecision": s.get("humanDecision"),
        }

    def board_post(self, session_id: str, params: Dict[str, Any]) -> Dict[str, Any]:
        agent_id = str(params.get("agentId") or "").strip()
        if not agent_id:
            raise DebateError("agentId is required")
        phase = str(params.get("phase") or "independent").strip()
        if phase not in ("independent", "rebuttal", "judge"):
            raise DebateError("phase must be independent, rebuttal, or judge")
        verdict = str(params.get("verdict") or "UNCERTAIN").strip().upper()
        summary = str(params.get("summary") or "").strip()
        if not summary:
            raise DebateError("summary is required")

        def mutate(s: Dict[str, Any]) -> Dict[str, Any]:
            if s["status"] == "human_decided":
                raise DebateError("session already has a recorded human decision")
            part = s["participants"].get(agent_id)
            role = "judge" if phase == "judge" else "debater"
            if part is None:
                model = str(params.get("model") or "")
                fam = str(params.get("family") or infer_family(model) or "unknown")
                part = {
                    "agentId": agent_id, "role": role, "mode": "external",
                    "model": model, "family": fam, "side": params.get("side"), "joinedAt": utc_now(),
                }
                s["participants"][agent_id] = part
            elif part["role"] == "observer":
                raise DebateError("observers cannot post verdicts")
            elif phase == "judge" and part["role"] != "judge":
                raise DebateError(f"agent {agent_id!r} is a {part['role']}, cannot post a judge ruling")
            elif phase != "judge" and part["role"] == "judge":
                raise DebateError(f"judge {agent_id!r} cannot post debater arguments")

            reg = {a["path"] for a in s.get("artifacts") or []}
            qs = verify_quotes_list(params.get("quotes"), self.cfg["allowedRoots"], s["cwd"], reg)
            round_num = int(params.get("round") if params.get("round") is not None else
                            (0 if phase == "independent" else max(1, s.get("round", 1))))
            entry = {
                "entryId": f"E-{uuid.uuid4().hex[:8]}",
                "createdAt": utc_now(),
                "phase": phase,
                "round": round_num,
                "agentId": agent_id,
                "role": role,
                "side": params.get("side") or part.get("side"),
                "model": str(params.get("model") or part.get("model") or ""),
                "family": str(params.get("family") or part.get("family") or "unknown"),
                "status": "ok",
                "error": None,
                "verdict": verdict,
                "confidence": _clamp_conf(params.get("confidence")),
                "summary": summary,
                "arguments": [str(a) for a in (params.get("arguments") or [])]
                if isinstance(params.get("arguments"), list) else [],
                "winningArguments": [str(a) for a in (params.get("winningArguments") or [])]
                if isinstance(params.get("winningArguments"), list) else [],
                "quoteSummary": qs,
                "crux": str(params.get("coreCrux") or params.get("crux") or "").strip(),
                "decisiveEvidence": str(params.get("decisiveEvidence") or "").strip(),
                "valueJudgment": bool(params.get("valueJudgment", False)),
                "needsHuman": bool(params.get("needsHuman", False)),
                "needsHumanReason": str(params.get("needsHumanReason") or "").strip(),
                "rawText": "",
                "meta": {"source": "board"},
            }
            s["entries"].append(entry)
            s["independenceReport"] = _compute_independence(s)
            if phase == "independent":
                ind_entries = [e for e in s["entries"] if e["role"] == "debater" and e["phase"] == "independent"]
                s["divergence"] = _check_divergence(ind_entries)
            elif phase == "rebuttal":
                s["phase"] = "rebuttal"
                s["round"] = max(int(s.get("round") or 0), round_num)
            elif phase == "judge":
                s["phase"] = "done"
                self._finalize_outcome(s)
            return entry

        entry = self.store.update(session_id, mutate)
        return {
            "sessionId": session_id,
            "entryId": entry["entryId"],
            "quoteSummary": entry["quoteSummary"],
            "warning": None if entry["quoteSummary"]["hasVerifiedAnchor"] else
            "No verified quotes attached; this entry will be downgraded during judging and human review.",
        }

    # ── Driven execution ─────────────────────────────────────────────────

    def _consume_budget(self, session: Dict[str, Any]) -> None:
        with self._budget_lock:
            b = session["budget"]
            if b["callsUsed"] >= b["maxCalls"]:
                raise DebateError(f"budget exhausted: maxCalls ({b['maxCalls']}) reached")
            b["callsUsed"] += 1

    def _invoke_agent(self, session: Dict[str, Any], agent_id: str, prompt_builder: Callable[[bool], str]) -> Tuple[CallResult, str, str]:
        spec = (self.cfg.get("agents") or {}).get(agent_id)
        if not spec:
            return CallResult(False, "", f"agent {agent_id!r} is not configured"), "", "unknown"
        if not spec.get("enabled"):
            return CallResult(False, "", f"agent {agent_id!r} is disabled in config"), spec.get("model") or "", spec.get("family") or "unknown"
        avail = availability(spec)
        if not avail["available"]:
            return CallResult(False, "", f"agent {agent_id!r} unavailable: {avail['detail']}"), spec.get("model") or "", spec.get("family") or "unknown"
        self._consume_budget(session)
        adapter = self.adapter_factory(spec, session["budget"]["timeoutSeconds"])
        prompt = prompt_builder(adapter.needs_inline_materials)
        res = adapter.ask(prompt, session["cwd"])
        with self._budget_lock:
            session["budget"]["elapsedSeconds"] = round(
                session["budget"].get("elapsedSeconds", 0.0) + float(res.meta.get("seconds") or 0.0), 2
            )
        fam = observed_family(spec, res.meta)
        reported = res.meta.get("reportedModels") or []
        model = str(reported[0]) if reported else (spec.get("model") or "")
        return res, model, fam

    def _run_parallel(self, items: List[Any], fn: Callable[[Any], Any], max_workers: int) -> List[Any]:
        if len(items) <= 1 or max_workers <= 1:
            return [fn(x) for x in items]
        results: List[Any] = [None] * len(items)
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(max_workers, len(items))) as pool:
            futs = {pool.submit(fn, item): i for i, item in enumerate(items)}
            for fut in concurrent.futures.as_completed(futs):
                results[futs[fut]] = fut.result()
        return results

    def run_session(self, session_id: str, force_debate: bool = False,
                    on_progress: Optional[ProgressFn] = None) -> Dict[str, Any]:
        session = self.store.load(session_id)
        if session["status"] == "human_decided":
            raise DebateError("session already has a recorded human decision; create a new session to re-run")
        staleness = check_artifact_staleness(session.get("artifacts") or [])
        if staleness["stale"]:
            raise DebateError(f"primary artifacts changed since session creation: {staleness}")

        session["status"] = "running"
        self.store.save(session)

        if session["preset"] == "topic_tournament":
            self._run_tournament(session, on_progress)
        else:
            self._run_standard(session, force_debate, on_progress)

        self.store.save(session)
        return self.get_status(session_id)

    def _run_standard(self, session: Dict[str, Any], force_debate: bool,
                      on_progress: Optional[ProgressFn]) -> None:
        allowed_roots = self.cfg["allowedRoots"]
        cwd = session["cwd"]
        reg = {a["path"] for a in session.get("artifacts") or []}
        max_inline = session["budget"]["maxInlineBytes"]
        max_par = session["budget"]["maxParallel"]

        driven_debaters = [p for p in session["participants"].values()
                           if p["role"] == "debater" and p["mode"] == "driven"]
        driven_judges = [p for p in session["participants"].values()
                         if p["role"] == "judge" and p["mode"] == "driven"]

        # Phase 1: Independent assessments (skip any debater who already posted in independent phase)
        already_ind = {e["agentId"] for e in session["entries"]
                       if e["role"] == "debater" and e["phase"] == "independent" and e["status"] == "ok"}
        todo_ind = [p for p in driven_debaters if p["agentId"] not in already_ind]
        if todo_ind:
            if on_progress:
                on_progress(f"Running {len(todo_ind)} independent assessment(s)...", 1, 4)

            def run_ind(part: Dict[str, Any]) -> Dict[str, Any]:
                try:
                    res, model, fam = self._invoke_agent(
                        session, part["agentId"],
                        lambda inline: _build_independent_prompt(session, part.get("side"), inline, max_inline),
                    )
                except DebateError as exc:
                    res, model, fam = CallResult(False, "", str(exc)), part.get("model", ""), part.get("family", "unknown")
                return _parse_entry(part["agentId"], "debater", "independent", 0, part.get("side"),
                                    model, fam, res, allowed_roots, cwd, reg)

            new_entries = self._run_parallel(todo_ind, run_ind, max_par)
            session["entries"].extend(new_entries)
            for e in new_entries:
                if e["agentId"] in session["participants"] and e["status"] == "ok":
                    session["participants"][e["agentId"]]["family"] = e["family"]
                    session["participants"][e["agentId"]]["model"] = e["model"]
            self.store.save(session)

        ind_entries = [e for e in session["entries"] if e["role"] == "debater" and e["phase"] == "independent"]
        div = _check_divergence(ind_entries, force_debate=force_debate)
        session["divergence"] = div
        session["independenceReport"] = _compute_independence(session)

        # Phase 2: Constrained rebuttal rounds ONLY if divergent
        max_rounds = session["budget"]["maxRounds"]
        if div["divergent"] and max_rounds > 0 and driven_debaters:
            session["phase"] = "rebuttal"
            for r in range(1, max_rounds + 1):
                if session["budget"]["callsUsed"] >= session["budget"]["maxCalls"]:
                    break
                session["round"] = r
                if on_progress:
                    on_progress(f"Divergence detected; running constrained rebuttal round {r}/{max_rounds}...", 2, 4)

                # Latest valid entry per debater as input to this round
                latest_map: Dict[str, Dict[str, Any]] = {}
                for e in session["entries"]:
                    if e["role"] == "debater" and e["status"] == "ok":
                        latest_map[e["agentId"]] = e
                peer_snapshot = list(latest_map.values())

                def run_reb(part: Dict[str, Any]) -> Dict[str, Any]:
                    try:
                        res, model, fam = self._invoke_agent(
                            session, part["agentId"],
                            lambda inline: _build_rebuttal_prompt(
                                session, r, part["agentId"], peer_snapshot, inline, max_inline
                            ),
                        )
                    except DebateError as exc:
                        res, model, fam = CallResult(False, "", str(exc)), part.get("model", ""), part.get("family", "unknown")
                    return _parse_entry(part["agentId"], "debater", "rebuttal", r, part.get("side"),
                                        model, fam, res, allowed_roots, cwd, reg)

                round_entries = self._run_parallel(driven_debaters, run_reb, max_par)
                session["entries"].extend(round_entries)
                self.store.save(session)

                # Early stopping if all valid debaters converged
                if not _check_divergence(round_entries)["divergent"]:
                    break

        # Phase 3: Independent judge(s)
        # Decide whether we need to call judge(s):
        #   - Always in challenge_adjudication (executor cannot close its own challenge)
        #   - Always when divergent, or requireHumanApproval, or same-family debaters, or explicit judges configured
        already_judged = {e["agentId"] for e in session["entries"]
                          if e["role"] == "judge" and e["status"] == "ok"}
        todo_judges = [p for p in driven_judges if p["agentId"] not in already_judged]
        need_judge = bool(todo_judges) and (
            div["divergent"]
            or session["preset"] == "challenge_adjudication"
            or session.get("requireHumanApproval")
            or not session["independenceReport"].get("crossFamilyDebaters")
            or len([e for e in ind_entries if e["status"] == "ok"]) < 2
        )
        if need_judge:
            session["phase"] = "judge"
            if on_progress:
                on_progress(f"Invoking {len(todo_judges)} independent judge(s)...", 3, 4)

            # Collect latest debater positions in randomized order
            latest_deb: Dict[str, Dict[str, Any]] = {}
            for e in session["entries"]:
                if e["role"] == "debater" and e["status"] == "ok":
                    latest_deb[e["agentId"]] = e
            deb_list = list(latest_deb.values())
            rng = random.Random(session.get("briefSeed", 0))
            rng.shuffle(deb_list)
            ordered = [(f"Position {chr(65 + i)}", e) for i, e in enumerate(deb_list)]

            def run_judge(part: Dict[str, Any]) -> Dict[str, Any]:
                try:
                    res, model, fam = self._invoke_agent(
                        session, part["agentId"],
                        lambda inline: _build_judge_prompt(session, ordered, inline, max_inline),
                    )
                except DebateError as exc:
                    res, model, fam = CallResult(False, "", str(exc)), part.get("model", ""), part.get("family", "unknown")
                return _parse_entry(part["agentId"], "judge", "judge", session.get("round", 0), None,
                                    model, fam, res, allowed_roots, cwd, reg)

            judge_entries = self._run_parallel(todo_judges, run_judge, max_par)
            session["entries"].extend(judge_entries)
            for e in judge_entries:
                if e["agentId"] in session["participants"] and e["status"] == "ok":
                    session["participants"][e["agentId"]]["family"] = e["family"]
                    session["participants"][e["agentId"]]["model"] = e["model"]

        session["phase"] = "done"
        self._finalize_outcome(session)
        if on_progress:
            on_progress(f"Debate finished with status {session['status']}.", 4, 4)

    def _run_tournament(self, session: Dict[str, Any], on_progress: Optional[ProgressFn]) -> None:
        allowed_roots = self.cfg["allowedRoots"]
        cwd = session["cwd"]
        reg = {a["path"] for a in session.get("artifacts") or []}
        max_inline = session["budget"]["maxInlineBytes"]
        max_par = session["budget"]["maxParallel"]
        swap = session["budget"].get("swapPositions", True)

        driven_debaters = [p for p in session["participants"].values()
                           if p["role"] == "debater" and p["mode"] == "driven"]
        driven_judges = [p for p in session["participants"].values()
                         if p["role"] == "judge" and p["mode"] == "driven"]
        if not driven_judges:
            raise DebateError("topic_tournament requires at least one configured judge agent")

        cands = session["candidates"]
        cand_by_id = {c["id"]: c for c in cands}
        pairs = list(itertools.combinations([c["id"] for c in cands], 2))
        rng = random.Random(session.get("briefSeed", 0))
        rng.shuffle(pairs)
        pairs = pairs[:session["budget"]["maxMatches"]]

        for idx, (cid_a, cid_b) in enumerate(pairs, 1):
            if session["budget"]["callsUsed"] >= session["budget"]["maxCalls"]:
                break
            ca, cb = cand_by_id[cid_a], cand_by_id[cid_b]
            if on_progress:
                on_progress(f"Tournament match {idx}/{len(pairs)}: {cid_a} vs {cid_b}...", idx, len(pairs))

            # Advocates (if driven debaters exist; rotate across available debaters)
            adv_a: Dict[str, Any] = {"status": "ok", "summary": ca.get("summary", ""), "arguments": [],
                                     "ownRisks": [], "rivalWeaknesses": [],
                                     "quoteSummary": {"quotes": [], "totalCount": 0, "verifiedCount": 0,
                                                      "unverifiedCount": 0, "hasVerifiedAnchor": False}}
            adv_b: Dict[str, Any] = {"status": "ok", "summary": cb.get("summary", ""), "arguments": [],
                                     "ownRisks": [], "rivalWeaknesses": [],
                                     "quoteSummary": {"quotes": [], "totalCount": 0, "verifiedCount": 0,
                                                      "unverifiedCount": 0, "hasVerifiedAnchor": False}}
            if driven_debaters:
                deb_a = driven_debaters[(idx - 1) % len(driven_debaters)]
                deb_b = driven_debaters[idx % len(driven_debaters)]

                def run_adv(spec_pair: Tuple[Dict[str, Any], Dict[str, Any], Dict[str, Any], str]) -> Dict[str, Any]:
                    part, mine, rival, side_label = spec_pair
                    try:
                        res, model, fam = self._invoke_agent(
                            session, part["agentId"],
                            lambda inline: _build_advocate_prompt(session, mine, rival, inline, max_inline),
                        )
                    except DebateError as exc:
                        res, model, fam = CallResult(False, "", str(exc)), part.get("model", ""), part.get("family", "unknown")
                    return _parse_entry(part["agentId"], "debater", "independent", idx, side_label,
                                        model, fam, res, allowed_roots, cwd, reg)

                adv_a, adv_b = self._run_parallel(
                    [(deb_a, ca, cb, cid_a), (deb_b, cb, ca, cid_b)], run_adv, max_par
                )

            judge_part = driven_judges[(idx - 1) % len(driven_judges)]

            def call_t_judge(first_c: Dict[str, Any], second_c: Dict[str, Any],
                             first_adv: Dict[str, Any], second_adv: Dict[str, Any]) -> Dict[str, Any]:
                try:
                    res, model, fam = self._invoke_agent(
                        session, judge_part["agentId"],
                        lambda inline: _build_tournament_judge_prompt(
                            session, first_c, second_c, first_adv, second_adv, inline, max_inline
                        ),
                    )
                except DebateError as exc:
                    res, model, fam = CallResult(False, "", str(exc)), judge_part.get("model", ""), judge_part.get("family", "unknown")
                return _parse_entry(judge_part["agentId"], "judge", "judge", idx, None,
                                    model, fam, res, allowed_roots, cwd, reg)

            fwd = call_t_judge(ca, cb, adv_a, adv_b)
            swp = None
            if swap and session["budget"]["callsUsed"] < session["budget"]["maxCalls"]:
                swp = call_t_judge(cb, ca, adv_b, adv_a)

            def map_winner(j_entry: Optional[Dict[str, Any]], opt1_id: str, opt2_id: str) -> Optional[str]:
                if not j_entry or j_entry.get("status") != "ok":
                    return None
                v = j_entry.get("verdict")
                if v == "OPTION_1":
                    return opt1_id
                if v == "OPTION_2":
                    return opt2_id
                if v == "DRAW":
                    return "draw"
                return None

            w_fwd = map_winner(fwd, cid_a, cid_b)
            w_swp = map_winner(swp, cid_b, cid_a) if swp is not None else None

            position_consistent: Optional[bool] = None
            if w_fwd is None:
                winner = "error"
                delta_a = delta_b = 0.0
            elif swp is not None and w_swp is not None:
                if w_fwd == w_swp:
                    position_consistent = True
                    winner = w_fwd
                else:
                    position_consistent = False
                    winner = "position_inconsistent"
            else:
                winner = w_fwd

            if winner == cid_a:
                ca["elo"], cb["elo"], delta_a, delta_b = _update_elo(ca["elo"], cb["elo"], 1.0)
                ca["wins"] += 1
                cb["losses"] += 1
            elif winner == cid_b:
                ca["elo"], cb["elo"], delta_a, delta_b = _update_elo(ca["elo"], cb["elo"], 0.0)
                cb["wins"] += 1
                ca["losses"] += 1
            elif winner in ("draw", "position_inconsistent"):
                ca["elo"], cb["elo"], delta_a, delta_b = _update_elo(ca["elo"], cb["elo"], 0.5)
                if winner == "draw":
                    ca["draws"] += 1
                    cb["draws"] += 1
                else:
                    ca["inconsistent"] += 1
                    cb["inconsistent"] += 1
            else:
                delta_a = delta_b = 0.0

            session["matches"].append({
                "matchId": f"M-{idx:03d}",
                "candidateA": cid_a,
                "candidateB": cid_b,
                "advocateA": adv_a,
                "advocateB": adv_b,
                "forwardJudge": fwd,
                "swappedJudge": swp,
                "winner": winner,
                "positionConsistent": position_consistent,
                "crux": fwd.get("crux") or (swp or {}).get("crux") or "",
                "decisiveEvidence": fwd.get("decisiveEvidence") or (swp or {}).get("decisiveEvidence") or "",
                "eloDeltaA": delta_a,
                "eloDeltaB": delta_b,
            })
            self.store.save(session)

        session["phase"] = "done"
        self._finalize_outcome(session)

    def _finalize_outcome(self, session: Dict[str, Any]) -> None:
        indep = _compute_independence(session)
        session["independenceReport"] = indep
        threshold = float(session["budget"].get("escalateBelowConfidence", 0.6))
        reasons: List[str] = []

        if session["preset"] == "topic_tournament":
            reasons.append("Topic selection always requires explicit human approval.")
            inconsistent = [m["matchId"] for m in session.get("matches") or [] if m.get("winner") == "position_inconsistent"]
            if inconsistent:
                reasons.append(f"Position-bias flip detected in match(es): {', '.join(inconsistent)}.")
            ranked = sorted(session.get("candidates") or [], key=lambda c: c.get("elo", 1500.0), reverse=True)
            top = ranked[0]["id"] if ranked else None
            session["aiOutcome"] = {
                "verdict": f"TOP_RANKED:{top}" if top else "INCONCLUSIVE",
                "confidence": None,
                "coreCrux": next((m.get("crux") for m in session.get("matches") or [] if m.get("crux")), ""),
                "decisiveEvidence": next((m.get("decisiveEvidence") for m in session.get("matches") or []
                                          if m.get("decisiveEvidence")), ""),
                "escalated": True,
                "escalationReasons": reasons,
                "resolutionKind": "human_required",
            }
            session["status"] = "awaiting_human"
            session["decisionBrief"] = _build_decision_brief(session)
            return

        judges = [e for e in session.get("entries") or [] if e["role"] == "judge" and e["status"] == "ok"]
        deb_ok = [e for e in session.get("entries") or [] if e["role"] == "debater" and e["status"] == "ok"]
        div = session.get("divergence") or {}

        if session.get("requireHumanApproval"):
            reasons.append("requireHumanApproval is enabled on this session.")

        verdict = "INCONCLUSIVE"
        confidence: Optional[float] = None
        core_crux = ""
        decisive = ""
        res_kind = "inconclusive"

        if judges:
            j_verdicts = {j["verdict"] for j in judges}
            confs = [j["confidence"] for j in judges if j.get("confidence") is not None]
            confidence = round(sum(confs) / len(confs), 3) if confs else None
            core_crux = next((j.get("crux") for j in judges if j.get("crux")), "")
            decisive = next((j.get("decisiveEvidence") for j in judges if j.get("decisiveEvidence")), "")

            if len(j_verdicts) > 1:
                reasons.append(f"Independent judges disagreed: {sorted(j_verdicts)}.")
                verdict = "SPLIT_JUDGES"
            else:
                verdict = next(iter(j_verdicts))
                res_kind = "independent_judge_resolved"

            if verdict == "ESCALATE_HUMAN":
                reasons.append("Judge explicitly returned ESCALATE_HUMAN.")
            for j in judges:
                if j.get("needsHuman"):
                    reasons.append(f"Judge {j['agentId']} requested human review: {j.get('needsHumanReason') or 'unspecified'}")
                if j.get("valueJudgment"):
                    reasons.append(f"Judge {j['agentId']} flagged this as a value judgment.")
            if confidence is not None and confidence < threshold:
                reasons.append(f"Judge confidence ({confidence}) is below threshold ({threshold}).")
            if session["preset"] == "challenge_adjudication":
                sev = (session.get("challenge") or {}).get("severity", "major")
                if sev in ("critical", "major") and not indep.get("crossFamilyJudge"):
                    reasons.append(f"{sev.title()} challenge judge is not verified cross-family.")
        elif not div.get("divergent") and len(deb_ok) >= 2 and indep.get("crossFamilyDebaters") \
                and session["preset"] == "general":
            verdict = deb_ok[-1]["verdict"]
            confs = [e["confidence"] for e in deb_ok if e.get("confidence") is not None]
            confidence = round(sum(confs) / len(confs), 3) if confs else None
            core_crux = next((e.get("crux") for e in deb_ok if e.get("crux")), "")
            decisive = next((e.get("decisiveEvidence") for e in deb_ok if e.get("decisiveEvidence")), "")
            res_kind = "unanimous_independent"
            if confidence is not None and confidence < threshold:
                reasons.append(f"Unanimous independent confidence ({confidence}) is below threshold ({threshold}).")
        else:
            reasons.append("No valid independent judge ruling was produced.")

        if session["budget"]["callsUsed"] >= session["budget"]["maxCalls"] and not judges:
            reasons.append("Call budget exhausted before convergence/judging.")

        escalated = bool(reasons)
        if escalated:
            res_kind = "human_required"

        session["aiOutcome"] = {
            "verdict": verdict,
            "confidence": confidence,
            "coreCrux": core_crux,
            "decisiveEvidence": decisive,
            "escalated": escalated,
            "escalationReasons": list(dict.fromkeys(reasons)),
            "resolutionKind": res_kind,
        }
        session["status"] = "awaiting_human" if escalated else "decided"
        session["decisionBrief"] = _build_decision_brief(session)

    # ── Human adjudication & status ──────────────────────────────────────

    def get_status(self, session_id: str) -> Dict[str, Any]:
        s = self.store.load(session_id)
        staleness = check_artifact_staleness(s.get("artifacts") or [])
        human = s.get("humanDecision")
        human_stale = False
        if human and staleness["stale"]:
            human_stale = True
        return {
            "sessionId": s["sessionId"],
            "preset": s["preset"],
            "title": s["title"],
            "status": s["status"],
            "phase": s["phase"],
            "round": s["round"],
            "budget": s["budget"],
            "participants": s["participants"],
            "divergence": s.get("divergence"),
            "independenceReport": s.get("independenceReport") or _compute_independence(s),
            "artifactStaleness": staleness,
            "aiOutcome": s.get("aiOutcome"),
            "decisionBrief": s.get("decisionBrief"),
            "humanDecision": human,
            "humanDecisionStale": human_stale,
            "card": s.get("card"),
            "entryCount": len(s.get("entries") or []),
            "matchCount": len(s.get("matches") or []),
        }

    def list_human_pending(self) -> List[Dict[str, Any]]:
        pending: List[Dict[str, Any]] = []
        for meta in self.store.list_sessions(status_filter="awaiting_human"):
            s = self.store.load(meta["sessionId"])
            brief = s.get("decisionBrief") or _build_decision_brief(s)
            pending.append({
                "sessionId": s["sessionId"],
                "preset": s["preset"],
                "title": s["title"],
                "question": s["question"],
                "createdAt": s["createdAt"],
                "escalationReasons": (s.get("aiOutcome") or {}).get("escalationReasons") or [],
                "artifactStaleness": check_artifact_staleness(s.get("artifacts") or []),
                "card": s.get("card"),
                "decisionBrief": brief,
            })
        return pending

    def submit_human_decision(self, session_id: str, params: Dict[str, Any]) -> Dict[str, Any]:
        # Optional import from downloaded HTML adjudication card JSON
        import_path = params.get("answersFile")
        if import_path:
            p = Path(str(import_path)).expanduser().resolve()
            if not p.is_file():
                raise DebateError(f"answersFile not found: {import_path}")
            imported = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(imported, dict):
                if imported.get("sessionId") and imported["sessionId"] != session_id:
                    raise DebateError(f"answersFile belongs to session {imported['sessionId']!r}, not {session_id!r}")
                items = imported.get("answers") or imported.get("items") or []
                first = items[0] if isinstance(items, list) and items else imported
                params = {
                    **params,
                    "verdict": params.get("verdict") or first.get("verdict") or first.get("decision"),
                    "selectedCandidateId": params.get("selectedCandidateId") or first.get("selectedCandidateId"),
                    "rationale": params.get("rationale") or first.get("rationale") or first.get("note") or "",
                    "blindPassFirst": first.get("blindPassFirst"),
                    "aiRevealedBeforeSubmit": first.get("aiRevealedBeforeSubmit"),
                    "importedFrom": str(p),
                }

        verdict = str(params.get("verdict") or "").strip().upper()
        selected_cand = params.get("selectedCandidateId")
        rationale = str(params.get("rationale") or "").strip()
        actor = str(params.get("actor") or "human").strip()
        allow_stale = bool(params.get("allowStale", False))

        if not verdict and not selected_cand:
            raise DebateError("human decision requires verdict (or selectedCandidateId for topic_tournament)")
        if not rationale:
            raise DebateError("rationale is required so human overrides and rulings remain auditable")

        def mutate(s: Dict[str, Any]) -> Dict[str, Any]:
            staleness = check_artifact_staleness(s.get("artifacts") or [])
            if staleness["stale"] and not allow_stale:
                raise DebateError(
                    "primary artifacts changed since debate started; re-run debate or pass allowStale=true "
                    f"explicitly. Details: {staleness}"
                )
            if s["preset"] == "topic_tournament" and selected_cand:
                valid_ids = {c["id"] for c in s.get("candidates") or []}
                if selected_cand not in valid_ids:
                    raise DebateError(f"selectedCandidateId {selected_cand!r} not in {sorted(valid_ids)}")
            final_verdict = verdict or f"APPROVED_TOPIC:{selected_cand}"
            decision = {
                "recordedAt": utc_now(),
                "actor": actor,
                "resolutionKind": "human_adjudicated",  # deliberately distinct from independent_judge_resolved
                "verdict": final_verdict,
                "selectedCandidateId": selected_cand,
                "rationale": rationale,
                "artifactHashesAtDecision": {a["displayPath"]: a["sha256"] for a in s.get("artifacts") or []},
                "staleAtDecision": staleness["stale"],
                "blindPassFirst": params.get("blindPassFirst"),
                "aiRevealedBeforeSubmit": params.get("aiRevealedBeforeSubmit"),
                "importedFrom": params.get("importedFrom"),
            }
            s["humanDecision"] = decision
            s["status"] = "human_decided"
            return decision

        decision = self.store.update(session_id, mutate)
        return {"sessionId": session_id, "status": "human_decided", "humanDecision": decision}
