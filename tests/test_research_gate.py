"""Tests for the self-contained skills-version research-gate controller and gates."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
CLAUDE_SCRIPT = ROOT / ".claude/skills/research-gate/scripts/research_gate.py"
CODEX_SCRIPT = ROOT / ".agents/skills/research-gate/scripts/research_gate.py"


def sha256_file(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def run_cli(script: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(script), *args],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        check=check,
    )


class ResearchGateSkillsControllerTests(unittest.TestCase):
    def setUp(self):
        workspace = tempfile.TemporaryDirectory()
        self.addCleanup(workspace.cleanup)
        self.ws = Path(workspace.name)

    def cli(self, *args):
        return json.loads(run_cli(CODEX_SCRIPT, *args, "--root", str(self.ws)).stdout)

    def test_full_eight_stage_gated_workflow_and_wrappers(self):
        self.exercise_eight_stages(self.ws)
        (self.ws / "research/delivery.md").write_text(
            "Para repetir a análise, execute o plano com os dados arquivados. "
            "Os resultados abrangem apenas uma execução."
        )
        self.assertTrue(self.cli("gate", "delivery")["result"]["passed"])

    def test_report_language_survives_resume_and_topic_still_requires_approval(self):
        self.cli("init", "--goal", "Avaliar políticas de memória", "--report-language", "Português")
        self.assertEqual(self.cli("continue")["reconstructionContext"]["reportLanguage"], "Português")
        (self.ws / "research/topic.md").write_text("  \n")
        empty = run_cli(CLAUDE_SCRIPT, "gate", "topic", "--root", str(self.ws), check=False)
        self.assertIn("Empty stage report", empty.stdout)
        (self.ws / "research/topic.md").write_text(
            "A implementação guarda eventos recentes. Resta saber se preserva decisões antigas. "
            "Uma garantia de retenção dessas decisões eliminaria a diferença proposta."
        )
        self.assertEqual(self.cli("gate", "topic")["result"]["status"], "awaiting_approval")
        self.assertEqual(self.cli("continue")["action"], "await_approval")

    def test_script_settings_default_on_and_persist_per_project(self):
        defaults = {"run-records": True, "latex-integrity": True, "figures": True}
        self.assertEqual(self.cli("init", "--goal", "Audit results")["scriptChecks"], defaults)
        statefile = self.ws / ".research-gate/state.json"
        legacy = json.loads(statefile.read_text())
        del legacy["scriptChecks"]
        statefile.write_text(json.dumps(legacy))
        self.assertEqual(self.cli("status")["scriptChecks"], defaults)
        self.cli("check", "figures", "off")
        wanted = {**defaults, "figures": False}
        self.assertEqual(self.cli("continue")["reconstructionContext"]["scriptChecks"], wanted)
        other = run_cli(CLAUDE_SCRIPT, "init", "--root", str(self.ws / "other"), "--goal", "Another project",
                        "--disable-check", "run-records", "--disable-check", "latex-integrity")
        self.assertEqual(json.loads(other.stdout)["scriptChecks"],
                         {"run-records": False, "latex-integrity": False, "figures": True})
        self.assertEqual(self.cli("preflight")["scriptChecks"], wanted)

    def test_disabled_scripts_are_skipped_independently_and_rechecked_on_enable(self):
        self.exercise_eight_stages(self.ws)
        empty_skills = self.ws / "empty-skills"
        empty_skills.mkdir()
        self.cli("check", "run-records", "off")
        result = self.cli("gate", "experiment", "--skills", str(empty_skills))["result"]
        self.assertTrue(result["passed"])
        self.assertEqual(result["scriptChecks"], {"run-records": False})
        self.cli("check", "run-records", "on")
        self.assertEqual(self.cli("continue")["stage"], "experiment")
        self.cli("gate", "experiment")
        self.assertEqual(self.cli("continue")["action"], "completed")

        (self.ws / "research/table.tex").write_text("A table.")
        (self.ws / "research/plot.py").write_text("def broken(:")
        for disabled, enabled, missing in (("figures", "latex-integrity", "LaTeX integrity precheck"),
                                          ("latex-integrity", "figures", "figure validator")):
            self.cli("check", disabled, "off")
            self.cli("check", enabled, "on")
            failed = run_cli(CLAUDE_SCRIPT, "gate", "writing", "--root", str(self.ws),
                             "--skills", str(empty_skills), check=False)
            self.assertNotEqual(failed.returncode, 0)
            result = json.loads(failed.stdout)["result"]
            self.assertEqual(result["scriptChecks"], {disabled: False, enabled: True})
            self.assertEqual(len(result["errors"]), 1)
            self.assertIn(missing, result["errors"][0])

        self.cli("check", "figures", "off")
        self.assertTrue(self.cli("gate", "writing", "--skills", str(empty_skills))["result"]["passed"])
        self.assertFalse((self.ws / ".research-gate/checks/integrity").exists())
        self.cli("gate", "review")
        self.cli("gate", "delivery")
        self.cli("check", "figures", "on")
        self.assertEqual(self.cli("continue")["stage"], "writing")
        failed = run_cli(CLAUDE_SCRIPT, "gate", "writing", "--root", str(self.ws), check=False)
        self.assertIn("SOURCE-SYNTAX", json.loads(failed.stdout)["result"]["errors"][0])

    def test_topic_accepts_descriptive_and_omitted_labels(self):
        for index, label in enumerate((None, "开放数据资源")):
            with self.subTest(label=label):
                root = str(self.ws / str(index))
                args = ["--paper-type", label] if label else []
                run_cli(CLAUDE_SCRIPT, "init", "--root", root, "--goal", "Release a curated corpus", *args)
                (Path(root) / "research/topic.md").write_text("Research question: how representative is the corpus?")
                gate = json.loads(run_cli(CODEX_SCRIPT, "gate", "topic", "--root", root).stdout)["result"]
                self.assertEqual(gate["status"], "awaiting_approval")
                confirmation = ["--type", label] if label else []
                run_cli(CODEX_SCRIPT, "approve", "topic", "--root", root, "--version", gate["approvalVersion"],
                        "--by", "test", "--response", "Approved corpus", *confirmation)
                run_cli(CLAUDE_SCRIPT, "paper-type", "--type", "dataset and formal analysis", "--root", root)
                self.assertEqual(json.loads(run_cli(CODEX_SCRIPT, "continue", "--root", root).stdout)["stage"], "topic")

    def test_proof_only_method_commits_to_the_files_named_in_its_protocol(self):
        self.exercise_eight_stages(self.ws)
        research = self.ws / "research"
        protocol = research / "protocol.md"
        protocol.write_text(protocol.read_text().replace(
            "| plan | research/planned-runs.json |",
            "| plan | research/definitions.md |\n| experiment | research/proof.txt |",
        ).replace("research/observed-runs.json", "research/proof.txt"))
        (research / "planned-runs.json").unlink()
        (research / "observed-runs.json").unlink()
        definitions = research / "definitions.md"
        definitions.write_text("Finite proof domain")
        version = self.cli("gate", "plan")["result"]["approvalVersion"]
        definitions.write_text("Countable proof domain")
        old_approval = run_cli(CODEX_SCRIPT, "approve", "plan", "--root", str(self.ws), "--version", version,
                               "--by", "test", "--response", "Approved", check=False)
        self.assertNotEqual(old_approval.returncode, 0)
        revised = self.cli("gate", "plan")["result"]["approvalVersion"]
        self.assertNotEqual(version, revised)
        self.cli("approve", "plan", "--version", revised, "--by", "test", "--response", "Approved proof")
        execution = self.cli("continue")
        self.assertEqual(execution["requiredArtifacts"], ["research/execution.md", "research/proof.txt"])
        self.assertNotIn("experiment-bridge", execution["recommendedSkills"])
        (research / "execution.md").write_text("The proof is recorded in the protocol's evidence file.")
        missing = run_cli(CODEX_SCRIPT, "gate", "experiment", "--root", str(self.ws), check=False)
        self.assertIn("Missing or empty required artifact for 'experiment': research/proof.txt", missing.stdout)
        (research / "proof.txt").write_text("The empty sum is zero.")
        self.cli("gate", "experiment")
        self.assertNotIn("analyze-results", self.cli("continue")["recommendedSkills"])
        (research / "proof.txt").write_text("The empty sum equals the additive identity.")
        self.assertEqual(self.cli("continue")["stage"], "experiment")
        self.cli("gate", "experiment")
        proof_claim = (
            "| Evidence ID | Source Ref | Level | Verbatim Anchor |\n|---|---|---|---|\n"
            "| EVD-PROOF | research/proof.txt | verified | `the additive identity` |\n\n"
            "| Claim ID | Statement | Evidence IDs | Level | Scope |\n|---|---|---|---|---|\n"
            "| CLM-SUM | Empty sums equal the additive identity | EVD-PROOF | verified | Defined sums |\n"
        )
        for stage, file in (("analysis", "analysis.md"), ("writing", "manuscript.md")):
            (research / file).write_text(proof_claim)
            self.cli("gate", stage)
        (self.ws / "PAPER_CLAIM_AUDIT.json").write_text(json.dumps({
            "verdict": "NOT_APPLICABLE", "reason_code": "no_numeric_claims",
            "audited_input_hashes": {"research/manuscript.md": sha256_file(research / "manuscript.md")},
        }))
        (research / "review.md").write_text("| Reviewer | Verdict | Summary |\n|---|---|---|\n"
                                            "| Fixture | PASS | Definition and proof agree |\n")
        self.cli("gate", "review")
        (research / "delivery.md").write_text("Reproduction: read the proof. Limitations: defined sums.")
        self.cli("gate", "delivery")
        self.assertEqual(self.cli("continue")["action"], "completed")

    def test_custom_mixed_paper_checks_both_committed_evidence_formats(self):
        self.exercise_eight_stages(self.ws)
        self.cli("paper-type", "resource and evaluation")
        version = self.cli("gate", "topic")["result"]["approvalVersion"]
        self.cli("approve", "topic", "--version", version, "--by", "test", "--response", "Approved")
        self.cli("gate", "literature")
        protocol = self.ws / "research/protocol.md"
        base = protocol.read_text()
        protocol.write_text(base.replace("| plan | research/planned-runs.json |", "| experiment | ../escape.txt |"))
        invalid = run_cli(CODEX_SCRIPT, "gate", "plan", "--root", str(self.ws), check=False)
        self.assertIn("Invalid protocol artifact", invalid.stdout)
        protocol.write_text(base.replace("| plan | research/planned-runs.json |",
                                        "| plan | research/planned-runs.json |\n| experiment | research/source-selection.json |"))
        version = self.cli("gate", "plan")["result"]["approvalVersion"]
        self.cli("approve", "plan", "--version", version, "--by", "test", "--response", "Approved")
        self.assertIn("experiment-bridge", self.cli("continue")["recommendedSkills"])
        selection = self.ws / "research/source-selection.json"
        selection.write_text("[]")
        observed = self.ws / "research/observed-runs.json"
        original = observed.read_text()
        observed.write_text(original.replace("completed", "pending"))
        errors = run_cli(CODEX_SCRIPT, "gate", "experiment", "--root", str(self.ws), check=False).stdout
        self.assertIn("Unfinished experiment attempts", errors)
        self.assertIn("Invalid research/source-selection.json", errors)
        observed.write_text(original)
        selection.write_text(json.dumps([{"sourceId": "SRC-1", "decision": "include", "reason": "In scope"}]))
        for stage in ("experiment", "analysis", "writing", "review", "delivery"):
            self.cli("gate", stage)
        self.assertEqual(self.cli("continue")["action"], "completed")

    def test_nonempirical_handoffs_after_switching_paper_type(self):
        self.exercise_eight_stages(self.ws)
        protocol = self.ws / "research/protocol.md"
        prior_protocol = protocol.read_text()
        routes = [
            ("theory", "definitions.md", "proofs.md", [], []),
            ("survey", "search-protocol.md", "source-selection.json", ["research-lit"], ["research-lit"]),
            ("position", "argument-plan.md", "argument-evidence.md", ["research-lit"], []),
        ]
        for paper_type, plan_file, execution_file, execution_skills, analysis_skills in routes:
            with self.subTest(paper_type=paper_type):
                self.cli("paper-type", paper_type)
                self.assertEqual(self.cli("continue")["stage"], "topic")
                version = self.cli("gate", "topic")["result"]["approvalVersion"]
                self.assertEqual(self.cli("continue")["action"], "await_approval")
                self.cli("approve", "topic", "--version", version, "--by", "test", "--response", "Approved")
                self.cli("gate", "literature")
                protocol.write_text(prior_protocol.replace(
                    "| plan | research/planned-runs.json |",
                    f"| plan | research/{plan_file} |\n| experiment | research/{execution_file} |",
                ))
                plan = self.cli("continue")
                self.assertEqual(plan["requiredArtifacts"], ["research/protocol.md", "research/" + plan_file])
                self.assertNotIn("experiment-plan", plan["recommendedSkills"])
                (self.ws / "research" / plan_file).write_text("Plan for " + paper_type)
                version = self.cli("gate", "plan")["result"]["approvalVersion"]
                self.assertEqual(self.cli("continue")["requiredArtifacts"], plan["requiredArtifacts"])
                self.cli("approve", "plan", "--version", version, "--by", "test", "--response", "Approved")

                execution = self.cli("continue")
                self.assertEqual(execution["requiredArtifacts"], ["research/execution.md", "research/" + execution_file])
                self.assertEqual(execution["recommendedSkills"], execution_skills)
                content = "Evidence for " + paper_type
                if paper_type == "survey":
                    content = json.dumps([{"sourceId": "SRC-1", "decision": "include", "reason": "Within scope"}])
                (self.ws / "research" / execution_file).write_text(content)
                self.cli("gate", "experiment")
                analysis = self.cli("continue")
                self.assertEqual(analysis["requiredArtifacts"], ["research/analysis.md"])
                self.assertEqual(analysis["recommendedSkills"], analysis_skills)

    def test_writing_precheck_and_figure_findings_are_advisory(self):
        self.exercise_eight_stages(self.ws)
        research = self.ws / "research"
        table = r"""\begin{table}
\begin{tabular}{cc}
1.2 & 3.4 \\
\end{tabular}
\end{table}
"""
        (research / "tables.tex").write_text(table + "\n" + table)
        plot = research / "plot.py"
        plot.write_text("from shared_style import render_figure\nrender_figure()\n")
        writing = self.cli("gate", "writing")["result"]
        self.assertTrue(writing["passed"])
        warnings = "\n".join(writing["warnings"])
        self.assertIn("plot.py [FONT-FAMILY]", warnings)
        self.assertIn("INTEGRITY_PRECHECK.md", warnings)
        report = self.ws / ".research-gate/checks/integrity/INTEGRITY_PRECHECK.md"
        self.assertIn("HP-DUP-TABLE", report.read_text())

        plot.write_text("def render_figure(:\n")
        failed = run_cli(CLAUDE_SCRIPT, "gate", "writing", "--root", str(self.ws), check=False)
        self.assertNotEqual(failed.returncode, 0)
        self.assertIn("plot.py [SOURCE-SYNTAX]", "\n".join(json.loads(failed.stdout)["result"]["errors"]))

    def test_review_suggestions_can_remain_open_through_delivery(self):
        self.exercise_eight_stages(self.ws)
        review = self.ws / "research/review.md"
        review_text = review.read_text().replace(
            "PASS | Claims match observed-runs.json", "Major revision | Suggest another dataset"
        ) + ("\n| Gap ID | Description | Blocking Stage | Status | Resolution |\n"
             "|---|---|---|---|---|\n| GAP-EXT | External validation | | open | |\n")
        review.write_text(review_text)
        result = self.cli("gate", "review")["result"]
        self.assertTrue(result["passed"])
        self.assertIn("Major revision", " ".join(result["warnings"]))
        self.cli("gate", "delivery")
        self.assertEqual(self.cli("continue")["action"], "completed")

        review.write_text(review_text.replace("External validation | |", "External validation | delivery |"))
        self.cli("gate", "review")
        failed = run_cli(CLAUDE_SCRIPT, "gate", "delivery", "--root", str(self.ws), check=False)
        self.assertIn("Open blocking gap GAP-EXT", failed.stdout)

        review.write_text(review_text)
        audit = self.ws / "PAPER_CLAIM_AUDIT.json"
        audit_data = json.loads(audit.read_text())
        audit.write_text(json.dumps({**audit_data, "verdict": "FAIL", "reason_code": "claim_mismatch"}))
        failed = run_cli(CLAUDE_SCRIPT, "gate", "review", "--root", str(self.ws), check=False)
        self.assertIn("PAPER_CLAIM_AUDIT.json verdict is FAIL", failed.stdout)

    def test_updated_approval_and_persistent_downstream_review(self):
        self.exercise_eight_stages(self.ws)
        for stage, filename, following in [("plan", "protocol", "experiment"), ("topic", "topic", "literature")]:
            with self.subTest(stage=stage):
                artifact = self.ws / f"research/{filename}.md"
                artifact.write_text(artifact.read_text() + "\nRevised comparison.\n")
                self.assertEqual(self.cli("continue")["action"], "fix_gate")
                result = self.cli("gate", stage)
                self.assertEqual(result["result"]["status"], "awaiting_approval")
                self.assertEqual(result["boundaryClosure"]["requiresApproval"], stage)
                self.assertEqual(self.cli("continue")["action"], "await_approval")
                self.cli("approve", stage, "--version", result["boundaryClosure"]["approvalVersion"], "--by", "researcher", "--response", "Approved revised comparison")
                resumed = self.cli("continue")
                self.assertEqual((resumed["stage"], resumed["action"]), (following, "fix_gate"))
                self.assertTrue(self.cli("gate", following)["result"]["passed"])
                self.assertNotEqual(self.cli("continue")["action"], "completed")

    def test_source_dependencies_in_new_and_legacy_workspaces(self):
        self.cli("init", "--goal", "Track sources", "--paper-type", "method")
        for sid in ("SRC-CITED", "SRC-UNUSED"):
            self.cli("source", "--id", sid, "--title", sid, "--identity", sid,
                     "--citations", sid.lower(), "--content", "Original text")
        topic = self.ws / "research/topic.md"
        topic.write_text(r"Research question and candidate comparison grounded in \cite{src-cited}.")
        gate = self.cli("gate", "topic")
        self.cli("approve", "topic", "--version", gate["result"]["approvalVersion"], "--by", "researcher", "--response", "Approved")
        unused = self.ws / ".research-gate/sources/SRC-UNUSED.txt"
        legacy_hash = sha256_file(unused)
        unused.write_text("New unrelated material")
        self.assertEqual(self.cli("continue")["stage"], "literature")

        statefile = self.ws / ".research-gate/state.json"
        state = json.loads(statefile.read_text())
        record = state["stages"]["topic"]
        record.pop("scopedInputs")
        record["inputHashes"][".research-gate/sources/SRC-UNUSED.txt"] = legacy_hash
        statefile.write_text(json.dumps(state))
        unused.unlink()
        self.assertEqual(self.cli("continue")["stage"], "literature")
        (self.ws / ".research-gate/sources/SRC-CITED.txt").unlink()
        self.assertEqual(self.cli("continue")["stage"], "topic")

    def test_rework_accepts_only_changes_to_stage_inputs(self):
        self.exercise_eight_stages(self.ws)
        note = self.ws / "research/execution.md"
        primary_before = sha256_file(note)
        self.cli("rework", "experiment", "--reason", "Correct run conditions")
        self.cli("source", "--id", "SRC-OTHER", "--title", "Unused", "--identity", "other",
                 "--content", "Unrelated source")
        blocked = run_cli(CODEX_SCRIPT, "gate", "experiment", "--root", str(self.ws), check=False)
        self.assertIn("requires changing target artifacts", blocked.stdout)
        observed = self.ws / "research/observed-runs.json"
        rows = json.loads(observed.read_text())
        rows[0]["condition"] = "corrected condition"
        observed.write_text(json.dumps(rows, indent=2))
        self.assertTrue(self.cli("gate", "experiment")["result"]["passed"])
        self.assertEqual(sha256_file(note), primary_before)
        self.assertEqual(self.cli("continue")["stage"], "analysis")

    def test_resume_extends_in_flight_legacy_rework(self):
        self.exercise_eight_stages(self.ws)
        self.cli("rework", "experiment", "--reason", "Correct attempt metadata")
        file = self.ws / ".research-gate/state.json"
        state = json.loads(file.read_text())
        rework = state["reworks"]
        cycle = rework["count"]
        rework.pop("scopedBaseline")
        primary = "research/execution.md"
        rework["baselineHashes"] = {primary: sha256_file(self.ws / primary)}
        file.write_text(json.dumps(state))
        self.assertEqual(self.cli("continue")["stage"], "experiment")
        observed = self.ws / "research/observed-runs.json"
        rows = json.loads(observed.read_text())
        rows[0]["attempt_id"] = "corrected-id"
        observed.write_text(json.dumps(rows, indent=2))
        self.cli("gate", "experiment")
        self.assertEqual(self.cli("status")["reworkCount"], cycle)

    def test_local_evidence_path_reopens_only_its_first_consumer(self):
        self.exercise_eight_stages(self.ws)
        evidence = self.ws / "research/local-evidence.json"
        evidence.write_bytes((self.ws / "research/observed-runs.json").read_bytes())
        analysis = self.ws / "research/analysis.md"
        analysis.write_text(analysis.read_text().replace("research/observed-runs.json", "research/local-evidence.json"))
        for stage in ("analysis", "writing", "review", "delivery"):
            self.cli("gate", stage)
        evidence.unlink()
        resume = self.cli("continue")
        self.assertEqual(resume["stage"], "analysis")
        self.assertIn("local-evidence.json", " ".join(resume["blockers"]))

    def test_standard_audit_precedence_and_input_freshness(self):
        self.exercise_eight_stages(self.ws)  # Existing root-level audit layout.
        paper = self.ws / "paper"
        paper.mkdir()
        main = paper / "main.tex"
        main.write_text("Audited manuscript")
        with tempfile.TemporaryDirectory() as external:
            raw = Path(external) / "results.csv"
            raw.write_text("value\n42\n")
            audit = paper / "PAPER_CLAIM_AUDIT.json"
            audit.write_text(json.dumps({"verdict": "PASS", "audited_input_hashes": {
                "main.tex": sha256_file(main), str(raw): sha256_file(raw)}}))
            self.assertEqual(self.cli("continue")["stage"], "review")
            self.cli("gate", "review")
            self.cli("gate", "delivery")
            self.assertEqual(self.cli("continue")["action"], "completed")
            for path in (main, raw):
                with self.subTest(path=path.name):
                    original = path.read_bytes()
                    path.write_text("revised")
                    resumed = self.cli("continue")
                    self.assertEqual(resumed["stage"], "review")
                    self.assertIn(path.name, " ".join(resumed["blockers"]))
                    result = run_cli(CODEX_SCRIPT, "gate", "review", "--root", str(self.ws), check=False)
                    self.assertNotEqual(result.returncode, 0)
                    path.write_bytes(original)
                    self.cli("gate", "review")
                    self.assertEqual(self.cli("continue")["stage"], "delivery")
                    self.cli("gate", "delivery")

            # Restore a corrupted audited file as the entire review repair.
            raw.write_text("corrupt result")
            self.cli("rework", "review", "--reason", "Restore the archived raw result")
            raw.write_text("value\n42\n")
            self.cli("gate", "review")
            self.cli("gate", "delivery")
            self.assertEqual(self.cli("continue")["action"], "completed")

    def test_unchanged_gate_keeps_downstream_acceptance(self):
        self.exercise_eight_stages(self.ws)
        self.cli("gate", "literature")
        self.assertEqual(self.cli("continue")["action"], "completed")
        lit = self.ws / "research/literature.md"
        lit.write_text(lit.read_text() + "\nUpdated interpretation.\n")
        self.cli("gate", "literature")
        for stage in ("plan", "experiment", "analysis", "writing", "review", "delivery"):
            self.assertEqual(self.cli("continue")["stage"], stage)
            self.assertTrue(self.cli("gate", stage)["result"]["passed"])
        self.assertEqual(self.cli("continue")["action"], "completed")

    def test_shown_approval_version_follows_frozen_inputs(self):
        self.exercise_eight_stages(self.ws)
        plan = self.cli("gate", "plan")["result"]["approvalVersion"]
        runs = self.ws / "research/planned-runs.json"
        runs.write_text('[{"run_id": "run-1", "condition": "revised"}]')
        def approve_old():
            return run_cli(CODEX_SCRIPT, "approve", "plan", "--version", plan, "--by", "user",
                           "--response", "Approved previous plan", "--root", str(self.ws), check=False)
        self.assertNotEqual(approve_old().returncode, 0)
        new = self.cli("gate", "plan")["boundaryClosure"]
        self.assertNotEqual(plan, new["approvalVersion"])
        self.assertEqual(new["requiresApproval"], "plan")
        self.assertNotEqual(approve_old().returncode, 0)
        self.cli("approve", "plan", "--version", new["approvalVersion"], "--by", "user", "--response", "Approved")
        self.cli("paper-type", "survey")
        self.assertEqual(self.cli("continue")["stage"], "topic")
        self.assertEqual(self.cli("gate", "topic")["boundaryClosure"]["requiresApproval"], "topic")

    def test_retrieval_ids_and_gap_resolution_across_stages(self):
        self.exercise_eight_stages(self.ws)
        lit = self.ws / "research/literature.md"
        original = lit.read_text()
        start = original.index("| Retrieval ID")
        end = original.index("| Evidence ID", start)
        lit.write_text(original[:start] + "Counterevidence search RET-2.\n\n" + original[end:] +
                       "\n| Gap ID | Description | Blocking Stage | Status | Resolution |\n"
                       "|---|---|---|---|---|\n| GAP-C | Calibration unresolved | plan | open | |\n")
        self.cli("gate", "literature")
        self.assertEqual(self.cli("continue")["reconstructionContext"]["openGaps"][0]["Gap ID"], "GAP-C")
        blocked = run_cli(CODEX_SCRIPT, "gate", "plan", "--root", str(self.ws), check=False)
        self.assertIn("Open blocking gap GAP-C", blocked.stdout)
        p = self.ws / "research/protocol.md"
        p.write_text(p.read_text() + "\n| Decision ID | Closes | Source Type | Rationale |\n"
                     "|---|---|---|---|\n| DEC-C | GAP-C | source-backed | Verified calibration in EVD-P1 |\n")
        revised = self.cli("gate", "plan")["result"]["approvalVersion"]
        self.cli("approve", "plan", "--version", revised, "--by", "user", "--response", "Approved")
        self.cli("gate", "experiment")
        self.cli("gate", "analysis")
        manuscript = self.ws / "research/manuscript.md"
        manuscript.write_text(manuscript.read_text().replace("| EVD-5 | verified | Bounded fixture",
                                                             "| EVD-UNKNOWN | verified | Bounded fixture"))
        blocked = run_cli(CODEX_SCRIPT, "gate", "writing", "--root", str(self.ws), check=False)
        self.assertIn("references undefined EVD-UNKNOWN", blocked.stdout)
        path = self.ws / ".research-gate/retrievals.jsonl"
        saved = path.read_text()
        records = [json.loads(row) for row in saved.splitlines()]
        record = next(r for r in records if r["id"] == "RET-2")
        path.write_text(saved + json.dumps({**record, "status": "planned"}) + "\n")
        self.assertEqual(self.cli("continue")["stage"], "literature")
        blocked = run_cli(CODEX_SCRIPT, "gate", "literature", "--root", str(self.ws), check=False)
        self.assertIn("Adversarial / counterevidence retrieval is required", blocked.stdout)
        path.unlink()
        blocked = run_cli(CODEX_SCRIPT, "gate", "literature", "--root", str(self.ws), check=False)
        self.assertIn("Unknown retrieval RET-2", blocked.stdout)

    def test_legacy_approval_is_reused_only_with_its_original_gate(self):
        self.exercise_eight_stages(self.ws)
        path = self.ws / ".research-gate/state.json"
        state = json.loads(path.read_text())
        for stage in ("topic", "plan"):
            state["approvals"][stage].pop("version")
            state["stages"][stage].pop("approvalVersion")
        path.write_text(json.dumps(state))
        self.assertEqual(self.cli("continue")["action"], "completed")
        # A later legacy recheck could have replaced the approved run manifest.
        state["stages"]["plan"]["checkedAt"] = "2099-01-01T00:00:00Z"
        path.write_text(json.dumps(state))
        self.assertEqual(self.cli("continue")["stage"], "plan")
        gate = self.cli("gate", "plan")["boundaryClosure"]
        self.assertEqual(gate["requiresApproval"], "plan")
        self.assertIn(gate["approvalVersion"], self.cli("continue")["approvalCommand"])

    def test_version_one_frozen_plan_survives_until_an_explicit_amendment(self):
        self.exercise_eight_stages(self.ws)
        protocol = self.ws / "research/protocol.md"
        table = "| Stage | Required artifact |\n|---|---|\n"
        protocol.write_text(protocol.read_text().replace(table + "| plan | research/planned-runs.json |\n", ""))
        statefile = self.ws / ".research-gate/state.json"
        state = json.loads(statefile.read_text())
        state["version"] = 1
        record = state["stages"]["plan"]
        record["artifactHash"] = record["inputHashes"]["research/protocol.md"] = sha256_file(protocol)
        frozen = {name: record["inputHashes"][name] for name in ("research/protocol.md", "research/planned-runs.json")}
        old_format = json.dumps({"files": frozen, "paperType": "method"}, sort_keys=True, separators=(",", ":"))
        record["approvalVersion"] = "sha256:" + hashlib.sha256(old_format.encode()).hexdigest()
        state["approvals"]["plan"].update(sha256=record["artifactHash"], version=record["approvalVersion"])
        statefile.write_text(json.dumps(state))
        self.assertEqual(self.cli("continue")["action"], "completed")

        (self.ws / "research/planned-runs.json").unlink()
        self.assertIn("research/planned-runs.json", self.cli("continue")["requiredArtifacts"])
        protocol.write_text(protocol.read_text() + "\n" + table)
        self.assertEqual(self.cli("continue")["requiredArtifacts"], ["research/protocol.md"])
        self.assertEqual(self.cli("gate", "plan")["result"]["status"], "awaiting_approval")

    def test_parallel_source_registrations_survive(self):
        self.cli("init", "--goal", "Concurrent registration", "--paper-type", "method")
        ids = [f"SRC-{n}" for n in range(24)]
        def register(sid):
            self.cli("source", "--id", sid, "--title", sid, "--identity", sid, "--content", sid)
        with ThreadPoolExecutor(8) as pool:
            list(pool.map(register, ids))
        state = json.loads((self.ws / ".research-gate/state.json").read_text())
        self.assertEqual(set(state["sources"]), set(ids))

    def exercise_eight_stages(self, ws):

        init_out = json.loads(
            run_cli(
                CLAUDE_SCRIPT,
                "init",
                "--root",
                str(ws),
                "--goal",
                "Evaluate modular skills-version gating",
                "--paper-type",
                "method",
                "--venue",
                "NeurIPS",
            ).stdout
        )
        self.assertTrue(init_out["initialized"])
        self.assertEqual(init_out["scaffolded"], ["research/topic.md"])

        pre_out = json.loads(run_cli(CLAUDE_SCRIPT, "preflight", "--root", str(ws)).stdout)
        self.assertTrue(pre_out["passed"])
        self.assertTrue(pre_out["validatorsAvailable"]["runRecords"])

        # Template still contains {{...}} placeholders, so topic gate must fail.
        fail_topic = run_cli(CLAUDE_SCRIPT, "gate", "topic", "--root", str(ws), check=False)
        self.assertNotEqual(fail_topic.returncode, 0)
        self.assertIn("Unfilled template placeholders", fail_topic.stdout)

        # Register source & retrieval, then write grounded topic.md.
        run_cli(
            CLAUDE_SCRIPT,
            "source",
            "--root",
            str(ws),
            "--id",
            "SRC-1",
            "--title",
            "Prior Gating Study",
            "--identity",
            "doi:10.1000/gate1",
            "--content",
            "Section 2: Deterministic disk gates prevent silent state drift across context resets.",
            "--citations",
            "gate2026",
        )
        run_cli(
            CLAUDE_SCRIPT,
            "retrieval",
            "--root",
            str(ws),
            "--id",
            "RET-1",
            "--intent",
            "support",
            "--provider",
            "openalex",
            "--query",
            "deterministic disk gates",
            "--ref",
            "SRC-1",
            "--status",
            "satisfied",
            "--source-id",
            "SRC-1",
        )

        topic_file = ws / "research/topic.md"
        topic_file.write_text(
            """# Topic Proposal
- Central research question: Do deterministic disk gates prevent silent drift?
- Candidate comparison: Prompt-only workflow vs research-gate controller.

Baseline retrieval: RET-1.

| Evidence ID | Source Ref | Location | Level | Verbatim Anchor | Summary |
|---|---|---|---|---|---|
| EVD-1 | SRC-1 | Section 2 | source-backed | `Deterministic disk gates prevent silent state drift` | Grounded |
""",
            encoding="utf-8",
        )

        topic_pass = json.loads(run_cli(CLAUDE_SCRIPT, "gate", "topic", "--root", str(ws)).stdout)
        self.assertTrue(topic_pass["result"]["passed"])
        self.assertEqual(topic_pass["result"]["status"], "awaiting_approval")
        self.assertTrue(topic_pass["boundaryClosure"]["canClear"])

        cont_before_app = json.loads(run_cli(CLAUDE_SCRIPT, "continue", "--root", str(ws)).stdout)
        self.assertEqual(cont_before_app["action"], "await_approval")
        self.assertNotIn("retrievalIntents", cont_before_app)
        self.assertNotIn("reviewInstruction", cont_before_app)

        # Cannot pass literature before topic approval.
        blocked_lit = run_cli(CLAUDE_SCRIPT, "gate", "literature", "--root", str(ws), check=False)
        self.assertNotEqual(blocked_lit.returncode, 0)

        # Approve topic (SHA-256 bound), then verify edit invalidates approval.
        run_cli(
            CLAUDE_SCRIPT,
            "approve",
            "topic",
            "--version",
            topic_pass["result"]["approvalVersion"],
            "--root",
            str(ws),
            "--by",
            "researcher",
            "--response",
            "Approved topic v1",
        )
        original_topic = topic_file.read_text(encoding="utf-8")
        topic_file.write_text(original_topic + "\nUnapproved edit.\n", encoding="utf-8")
        stale_status = json.loads(run_cli(CODEX_SCRIPT, "status", "--root", str(ws)).stdout)
        self.assertEqual(stale_status["stages"][0]["status"], "stale")
        topic_file.write_text(original_topic, encoding="utf-8")

        # Literature stage: rejects hallucinated anchor, passes with exact verbatim anchor + adversarial RET-*.
        literature = json.loads(run_cli(CLAUDE_SCRIPT, "continue", "--root", str(ws)).stdout)
        self.assertEqual(literature["retrievalIntents"], {"counterevidence": ["adversarial"]})
        run_cli(
            CLAUDE_SCRIPT,
            "retrieval",
            "--root",
            str(ws),
            "--id",
            "RET-2",
            "--intent",
            "adversarial",
            "--provider",
            "openalex",
            "--query",
            "limitations of disk gates",
            "--ref",
            "SRC-1",
            "--status",
            "satisfied",
            "--source-id",
            "SRC-1",
        )
        lit_file = ws / "research/literature.md"
        lit_file.write_text(
            """# Literature
Citation \\cite{gate2026}.

| Retrieval ID | Intent | Provider | Source Ref | Status | Notes |
|---|---|---|---|---|---|
| RET-2 | adversarial | openalex | SRC-1 | satisfied | Counterevidence |

| Evidence ID | Source Ref | Location | Level | Verbatim Anchor | Summary |
|---|---|---|---|---|---|
| EVD-2 | SRC-1 | Section 2 | source-backed | `Hallucinated claim absent from source` | Bad |
""",
            encoding="utf-8",
        )
        bad_lit = run_cli(CLAUDE_SCRIPT, "gate", "literature", "--root", str(ws), check=False)
        self.assertNotEqual(bad_lit.returncode, 0)
        self.assertIn("verbatim anchor", bad_lit.stdout)

        lit_file.write_text(
            lit_file.read_text(encoding="utf-8").replace(
                "Hallucinated claim absent from source",
                "prevent silent state drift across context resets",
            ),
            encoding="utf-8",
        )
        self.assertEqual(run_cli(CLAUDE_SCRIPT, "gate", "literature", "--root", str(ws)).returncode, 0)

        # Plan stage: requires RITP + venue retrieval (targetVenue=NeurIPS) + EVD-* + CLM-* + SCN-*.
        plan = json.loads(run_cli(CODEX_SCRIPT, "continue", "--root", str(ws)).stdout)
        self.assertEqual(plan["requiredArtifacts"], ["research/protocol.md"])
        self.assertIn("research/planned-runs.json", plan["suggestedEvidence"]["plan"])
        self.assertIn("experiment-plan", plan["recommendedSkills"])
        self.assertEqual(plan["retrievalIntents"], {
            "protocolCalibration": ["methodology", "support", "adversarial"],
            "venueRequirements": ["venue"],
        })
        (ws / "research/planned-runs.json").write_text(
            json.dumps([{"run_id": "run-1", "condition": "gated"}], indent=2),
            encoding="utf-8",
        )
        protocol_file = ws / "research/protocol.md"
        protocol_file.write_text(
            """# Protocol
Comparator \\cite{gate2026}.

| Claim ID | Statement | Evidence IDs | Level | Scope |
|---|---|---|---|---|
| CLM-1 | Disk gating reduces drift | EVD-1 | source-backed | Host workflow |

| Scenario ID | Criterion | Status | Evidence |
|---|---|---|---|
| SCN-1 | Zero unverified transitions | planned | research/observed-runs.json |
""",
            encoding="utf-8",
        )
        bad_plan = run_cli(CLAUDE_SCRIPT, "gate", "plan", "--root", str(ws), check=False)
        self.assertNotEqual(bad_plan.returncode, 0)
        self.assertIn("RITP retrieval", bad_plan.stdout)
        self.assertIn("Target venue 'NeurIPS'", bad_plan.stdout)

        run_cli(
            CLAUDE_SCRIPT,
            "source",
            "--root",
            str(ws),
            "--id",
            "SRC-VENUE",
            "--title",
            "NeurIPS Author Guidelines",
            "--identity",
            "https://neurips.cc/Conferences/2026/CallForPapers",
            "--content",
            "Main track submissions are limited to 9 content pages plus unlimited references.",
        )
        run_cli(
            CLAUDE_SCRIPT,
            "retrieval",
            "--root",
            str(ws),
            "--id",
            "RET-3",
            "--intent",
            "methodology",
            "--provider",
            "openalex",
            "--query",
            "disk gate benchmark protocol",
            "--ref",
            "SRC-1",
            "--status",
            "satisfied",
            "--source-id",
            "SRC-1",
        )
        run_cli(
            CLAUDE_SCRIPT,
            "retrieval",
            "--root",
            str(ws),
            "--id",
            "RET-4",
            "--intent",
            "venue",
            "--provider",
            "official_cfp",
            "--query",
            "NeurIPS 2026 page limit",
            "--ref",
            "SRC-VENUE",
            "--status",
            "satisfied",
            "--source-id",
            "SRC-VENUE",
        )
        protocol_file.write_text(
            """# Protocol
Comparator \\cite{gate2026}.

Calibration uses RET-3 and the venue requirements from RET-4.

| Stage | Required artifact |
|---|---|
| plan | research/planned-runs.json |

| Evidence ID | Source Ref | Location | Read Scope | Level | Verbatim Anchor | Summary |
|---|---|---|---|---|---|---|
| EVD-P1 | SRC-1 | Section 2 | full_text | source-backed | `Deterministic disk gates prevent silent state drift` | Baseline metric |
| EVD-P2 | SRC-VENUE | CFP | official_page | source-backed | `limited to 9 content pages` | Format limit |

| Claim ID | Statement | Evidence IDs | Level | Scope |
|---|---|---|---|---|
| CLM-1 | Disk gating reduces drift | EVD-P1 | source-backed | Host workflow |

| Scenario ID | Criterion | Status | Evidence |
|---|---|---|---|
| SCN-1 | Zero unverified transitions | planned | research/observed-runs.json |
""",
            encoding="utf-8",
        )
        plan_pass = json.loads(run_cli(CLAUDE_SCRIPT, "gate", "plan", "--root", str(ws)).stdout)
        run_cli(
            CLAUDE_SCRIPT,
            "approve",
            "plan",
            "--version",
            plan_pass["result"]["approvalVersion"],
            "--root",
            str(ws),
            "--by",
            "researcher",
            "--response",
            "Protocol frozen",
        )

        # Experiment stage + check_run_records.py + rework baseline check.
        (ws / "research/observed-runs.json").write_text(
            json.dumps(
                [{"run_id": "run-1", "attempt_id": "att-1", "status": "completed", "metrics": {"drift_rate": 0.0}}],
                indent=2,
            ),
            encoding="utf-8",
        )
        run_cli(
            CLAUDE_SCRIPT,
            "source",
            "--root",
            str(ws),
            "--id",
            "SRC-RUN",
            "--title",
            "Observed Run Log",
            "--identity",
            "local:observed-runs",
            "--file",
            "research/observed-runs.json",
        )
        exec_file = ws / "research/execution.md"
        exec_file.write_text(
            """# Execution
| Evidence ID | Source Ref | Location | Level | Verbatim Anchor | Summary |
|---|---|---|---|---|---|
| EVD-3 | SRC-RUN | json | verified | `"drift_rate": 0.0` | Run completed |
""",
            encoding="utf-8",
        )
        self.assertEqual(run_cli(CLAUDE_SCRIPT, "gate", "experiment", "--root", str(ws)).returncode, 0)

        run_cli(CLAUDE_SCRIPT, "rework", "experiment", "--root", str(ws), "--reason", "Add failure-case note")
        rework_unchanged = run_cli(CLAUDE_SCRIPT, "gate", "experiment", "--root", str(ws), check=False)
        self.assertNotEqual(rework_unchanged.returncode, 0)
        self.assertIn("requires changing target artifacts", rework_unchanged.stdout)
        exec_file.write_text(exec_file.read_text(encoding="utf-8") + "\nAdded failure-case notes.\n", encoding="utf-8")
        self.assertEqual(run_cli(CLAUDE_SCRIPT, "gate", "experiment", "--root", str(ws)).returncode, 0)

        # Analysis & Writing stages.
        (ws / "research/analysis.md").write_text(
            """# Analysis
| Evidence ID | Source Ref | Location | Level | Verbatim Anchor | Summary |
|---|---|---|---|---|---|
| EVD-4 | research/observed-runs.json | line 1 | verified | `"status": "completed"` | Completed |

| Claim ID | Statement | Evidence IDs | Level | Scope |
|---|---|---|---|---|
| CLM-1 | Zero drift observed in run-1 | EVD-4 | verified | Bounded fixture |
""",
            encoding="utf-8",
        )
        self.assertEqual(run_cli(CLAUDE_SCRIPT, "gate", "analysis", "--root", str(ws)).returncode, 0)

        manuscript_file = ws / "research/manuscript.md"
        # Abstract-only evidence cannot support a body claim unless Scope is narrowed.
        manuscript_file.write_text(
            """# Manuscript
As shown in \\cite{gate2026}, disk gating prevented drift.

| Evidence ID | Source Ref | Location | Read Scope | Level | Verbatim Anchor | Summary |
|---|---|---|---|---|---|---|
| EVD-5 | research/observed-runs.json | results | raw_output | verified | `"drift_rate": 0.0` | Matches run-1 |
| EVD-ABS | SRC-1 | abstract | abstract | source-backed | `prevent silent state drift` | Abstract only |

| Claim ID | Statement | Evidence IDs | Level | Scope |
|---|---|---|---|---|
| CLM-1 | Zero drift observed in run-1 | EVD-5 | verified | Bounded fixture |
| CLM-2 | Prior method fails in practice | EVD-ABS | source-backed | Full-body comparison |
""",
            encoding="utf-8",
        )
        shallow_fail = run_cli(CLAUDE_SCRIPT, "gate", "writing", "--root", str(ws), check=False)
        self.assertNotEqual(shallow_fail.returncode, 0)
        self.assertIn("shallow (abstract) evidence", shallow_fail.stdout)

        manuscript_file.write_text(
            manuscript_file.read_text(encoding="utf-8").replace(
                "| EVD-ABS | SRC-1 | abstract | abstract |",
                "| EVD-ABS | SRC-1 | Section 2 | full_text |",
            ),
            encoding="utf-8",
        )
        self.assertEqual(run_cli(CLAUDE_SCRIPT, "gate", "writing", "--root", str(ws)).returncode, 0)

        # Review & Delivery stages with PAPER_CLAIM_AUDIT.json freshness.
        review = json.loads(run_cli(CODEX_SCRIPT, "continue", "--root", str(ws)).stdout)
        self.assertIn("research-review", review["recommendedSkills"])
        self.assertIn("Wait for the reviewer's response", review["reviewInstruction"])
        self.assertEqual(review["retrievalIntents"], {})
        (ws / "PAPER_CLAIM_AUDIT.json").write_text(
            json.dumps(
                {
                    "verdict": "PASS",
                    "audited_input_hashes": {
                        "research/manuscript.md": sha256_file(manuscript_file),
                        "research/observed-runs.json": sha256_file(ws / "research/observed-runs.json"),
                    },
                }
            ),
            encoding="utf-8",
        )
        (ws / "research/review.md").write_text(
            """# Review
| Reviewer | Family | Verdict | Summary |
|---|---|---|---|
| claude-reviewer | cross_family | PASS | Claims match observed-runs.json |
""",
            encoding="utf-8",
        )
        self.assertEqual(run_cli(CLAUDE_SCRIPT, "gate", "review", "--root", str(ws)).returncode, 0)

        (ws / "research/delivery.md").write_text(
            """# Delivery
## Reproduction Instructions
Run check_run_records.py on planned-runs.json and observed-runs.json.

## Limitations
Single fixture run; submission stays with user.
""",
            encoding="utf-8",
        )
        self.assertEqual(run_cli(CLAUDE_SCRIPT, "gate", "delivery", "--root", str(ws)).returncode, 0)
        cont_done = json.loads(run_cli(CODEX_SCRIPT, "continue", "--root", str(ws)).stdout)
        self.assertEqual(cont_done["action"], "completed")


if __name__ == "__main__":
    unittest.main()
