#!/usr/bin/env python3
"""Self-contained CLI entrypoint for the skills-version research-gate controller."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from controller import (  # noqa: E402
    approve_stage,
    continue_gate,
    init_gate,
    preflight_gate,
    record_retrieval,
    register_source,
    rework_stage,
    run_gate_check,
    scaffold_stage,
    set_paper_type,
    set_script_check,
    status_gate,
)
from state import GateStore
from models import APPROVAL_STAGES, GATE_STAGES, SCRIPT_CHECK_STAGES  # noqa: E402

DEFAULT_SKILL_ROOT = Path(__file__).resolve().parents[2]


def _emit(payload: dict) -> None:
    print(json.dumps(payload, indent=2, ensure_ascii=False))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="research_gate.py",
        description="Modular disk-backed gate controller for the skills research workflow.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init")
    p_init.add_argument("--root", default=".")
    p_init.add_argument("--goal", required=True)
    p_init.add_argument("--paper-type", help="Optional contribution label or description")
    p_init.add_argument("--venue", default=None)
    p_init.add_argument("--report-language", help="Preferred language for user-facing reports (e.g. English)")
    p_init.add_argument("--max-revisions", type=int, default=3)
    p_init.add_argument("--no-plan-approval", action="store_true")
    p_init.add_argument("--disable-check", choices=SCRIPT_CHECK_STAGES, action="append", default=[],
                        help="Disable one script for this project. Repeat to disable more.")
    p_init.add_argument("--skills", default=str(DEFAULT_SKILL_ROOT))

    p_pre = sub.add_parser("preflight")
    p_pre.add_argument("--root", default=".")
    p_pre.add_argument("--skills", default=str(DEFAULT_SKILL_ROOT))

    p_scaf = sub.add_parser("scaffold")
    p_scaf.add_argument("stage_pos", nargs="?")
    p_scaf.add_argument("--stage")
    p_scaf.add_argument("--root", default=".")
    p_scaf.add_argument("--force", action="store_true")
    p_scaf.add_argument("--skills", default=str(DEFAULT_SKILL_ROOT))

    p_pt = sub.add_parser("paper-type")
    p_pt.add_argument("type_pos", nargs="?")
    p_pt.add_argument("--type")
    p_pt.add_argument("--root", default=".")

    p_src = sub.add_parser("source")
    p_src.add_argument("--root", default=".")
    p_src.add_argument("--id", required=True)
    p_src.add_argument("--title", required=True)
    p_src.add_argument("--identity", required=True)
    p_src.add_argument("--file", default=None)
    p_src.add_argument("--content", default=None)
    p_src.add_argument("--citations", default="")

    p_ret = sub.add_parser("retrieval")
    p_ret.add_argument("--root", default=".")
    p_ret.add_argument("--id", required=True)
    p_ret.add_argument("--intent", required=True, choices=["support", "adversarial", "venue", "methodology"])
    p_ret.add_argument("--provider", required=True)
    p_ret.add_argument("--query", required=True)
    p_ret.add_argument("--ref", required=True)
    p_ret.add_argument("--status", required=True, choices=["planned", "attempted", "satisfied", "not-applicable"])
    p_ret.add_argument("--source-id", default=None)

    p_gate = sub.add_parser("gate")
    p_gate.add_argument("stage_pos", nargs="?")
    p_gate.add_argument("--stage", choices=GATE_STAGES)
    p_gate.add_argument("--root", default=".")
    p_gate.add_argument("--skills", default=str(DEFAULT_SKILL_ROOT))

    p_app = sub.add_parser("approve")
    p_app.add_argument("stage_pos", nargs="?")
    p_app.add_argument("--stage", choices=APPROVAL_STAGES)
    p_app.add_argument("--root", default=".")
    p_app.add_argument("--by", required=True)
    p_app.add_argument("--response", required=True)
    p_app.add_argument("--version", required=True, help="Version from the gate shown to the user")
    p_app.add_argument("--type")
    p_app.add_argument("--skills", default=str(DEFAULT_SKILL_ROOT))

    p_rw = sub.add_parser("rework")
    p_rw.add_argument("target_pos", nargs="?")
    p_rw.add_argument("--target", choices=GATE_STAGES)
    p_rw.add_argument("--root", default=".")
    p_rw.add_argument("--reason", required=True)

    p_st = sub.add_parser("status")
    p_st.add_argument("--root", default=".")

    p_check = sub.add_parser("check", help="Enable or disable one project's validation script")
    p_check.add_argument("name", choices=SCRIPT_CHECK_STAGES)
    p_check.add_argument("setting", choices=("on", "off"))
    p_check.add_argument("--root", default=".")

    p_ct = sub.add_parser("continue")
    p_ct.add_argument("--root", default=".")
    p_ct.add_argument("--skills", default=str(DEFAULT_SKILL_ROOT))

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command in {"status", "preflight"}:
            return dispatch(args)
        with GateStore(args.root).command_lock(initializing=args.command in {"init", "scaffold"}):
            return dispatch(args)
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


def dispatch(args: argparse.Namespace) -> int:
    cmd = args.command
    if cmd == "init":
        res = init_gate(
            args.root,
            goal=args.goal,
            paper_type=args.paper_type,
            target_venue=args.venue,
            report_language=args.report_language,
            max_revisions=args.max_revisions,
            require_plan_approval=not args.no_plan_approval,
            disabled_checks=args.disable_check,
            skill_root=Path(args.skills).resolve(),
        )
        _emit(
            {
                "initialized": True,
                "root": str(Path(args.root).resolve()),
                "stateFile": ".research-gate/state.json",
                "paperType": res["state"]["paperType"],
                "reportLanguage": res["state"]["reportLanguage"],
                "scriptChecks": res["state"]["scriptChecks"],
                "scaffolded": res["scaffolded"],
            }
        )
        return 0
    if cmd == "preflight":
        report = preflight_gate(args.root, Path(args.skills).resolve())
        _emit(report)
        return 0 if report["passed"] else 1
    if cmd == "scaffold":
        stage = args.stage_pos or args.stage
        if not stage:
            raise ValueError("--stage is required")
        _emit(scaffold_stage(args.root, stage, Path(args.skills).resolve(), force=args.force))
        return 0
    if cmd == "paper-type":
        ptype = args.type_pos or args.type
        if not ptype:
            raise ValueError("--type is required")
        state = set_paper_type(args.root, ptype)
        _emit({"paperType": state["paperType"]})
        return 0
    if cmd == "source":
        keys = [k.strip() for k in args.citations.split(",") if k.strip()]
        src = register_source(
            args.root,
            source_id=args.id,
            title=args.title,
            identity=args.identity,
            file_path=args.file,
            content=args.content,
            citation_keys=keys,
        )
        _emit({"registered": src})
        return 0
    if cmd == "retrieval":
        rec = record_retrieval(
            args.root,
            retrieval_id=args.id,
            intent=args.intent,
            provider=args.provider,
            query=args.query,
            source_ref=args.ref,
            status=args.status,
            source_id=args.source_id,
        )
        _emit({"recorded": rec})
        return 0
    if cmd == "gate":
        stage = args.stage_pos or args.stage
        if not stage:
            raise ValueError("--stage is required")
        outcome = run_gate_check(args.root, stage, Path(args.skills).resolve())
        _emit(outcome)
        return 0 if outcome["result"]["passed"] else 1
    if cmd == "approve":
        stage = args.stage_pos or args.stage
        if not stage:
            raise ValueError("--stage is required")
        state = approve_stage(
            args.root,
            stage,
            by=args.by,
            response=args.response,
            version=args.version,
            paper_type=args.type,
            skill_root=Path(args.skills).resolve(),
        )
        _emit({"approved": state["approvals"][stage]})
        return 0
    if cmd == "rework":
        target = args.target_pos or args.target
        if not target:
            raise ValueError("--target is required")
        state = rework_stage(args.root, target, args.reason)
        _emit({"rework": state["reworks"]})
        return 0
    if cmd == "status":
        _emit(status_gate(args.root))
        return 0
    if cmd == "check":
        _emit({"scriptChecks": set_script_check(args.root, args.name, enabled=args.setting == "on")})
        return 0
    if cmd == "continue":
        _emit(continue_gate(args.root, Path(args.skills).resolve()))
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
