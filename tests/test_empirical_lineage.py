"""Check the evidence, workflow handoffs, and generated skills for baseline lineage."""

from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
CLAUDE_SKILLS = ROOT / ".claude/skills"
CODEX_SKILLS = ROOT / ".agents/skills"
EVIDENCE = "research-companion/principles/ideation-evidence.md"
LITERATURE = "research-lit/SKILL.md"
BENCHMARK = "benchmark-research-skill/SKILL.md"
PLAN = "experiment-plan/SKILL.md"
NOVELTY = "novelty-check/SKILL.md"


def read(path):
    return path.read_text(encoding="utf-8")


def section(path, start, end):
    content = read(CLAUDE_SKILLS / path)
    start_at = content.index(f"\n{start}\n")
    end_at = content.index(f"\n{end}\n", start_at + 1)
    return content[start_at:end_at]


class EmpiricalLineageTests(unittest.TestCase):
    def test_lineage_evidence_and_acknowledgements(self):
        lineage_row = next(
            line for line in read(CLAUDE_SKILLS / EVIDENCE).splitlines()
            if line.startswith("|") and "arXiv:2611.25845" in line
        )
        finding, source, rule = lineage_row.strip("|").split("|")
        for marker in ("6.69% Recall@20", "5.59% Direct Recall@20",
                       "one-hop neighbors in either direction", "lineage distance",
                       "individual hits"):
            self.assertIn(marker, finding)
        self.assertIn("Table 3", source)
        for marker in ("seed papers", "1–2 hops in both directions",
                       "`uses_baseline`", "`is_baseline_of`", "full-text experiment tables"):
            self.assertIn(marker, rule)

        for filename, attribution in (("README.md", "no text copied"),
                                      ("README_CN.md", "未复制原文")):
            with self.subTest(filename=filename):
                row = next(line for line in read(ROOT / filename).splitlines()
                           if line.startswith("| [LINEAGE]"))
                self.assertIn("https://arxiv.org/abs/2611.25845", row)
                self.assertIn(attribution, row)

    def test_literature_search_checks_seeds_and_extracts_supported_edges(self):
        queries = section(LITERATURE, "#### Multi-facet queries",
                          "### Step 1.5: Verify Candidate Papers (anti-hallucination, mandatory)")
        for marker in ("Topical", "Contextual", "Methodological", "keyword query",
                       "semantic query", "Top-20", "rewrite", "coverage gap"):
            self.assertIn(marker, queries)

        extraction = section(LITERATURE, "#### Empirical comparison fields", "### Step 3: Synthesize")
        for marker in ("Background citation", "`source uses_baseline baseline`",
                       "`baseline is_baseline_of source`", "stable paper IDs",
                       "experiment table or section locator", "baseline year ≤ source year",
                       "as unverified"):
            self.assertIn(marker, extraction)

    def test_benchmark_survey_confirms_both_directions_before_planning(self):
        survey = section(BENCHMARK, "### Trace the empirical comparison neighborhood",
                         "## Single-paper analysis")
        survey = " ".join(survey.split())
        for marker in ("2–3 core seed method papers", "Backward, one hop (`uses_baseline`)",
                       "Forward, one hop (`is_baseline_of`)", "citation chains",
                       "candidate-restricted grounding", "selected full text", "temporal",
                       "Methodology papers", "Survey or Benchmark summary tables",
                       "replication evidence"):
            self.assertIn(marker, survey)

        plan = section(PLAN, "## Select existing benchmarks before proposing construction",
                       "## Design a compact evidence package")
        for marker in ("first reuse the verified `uses_baseline`", "`is_baseline_of`",
                       "targeted full-text comparison checks", "established comparators"):
            self.assertIn(marker, plan)

    def test_novelty_queries_preserve_the_four_decisions(self):
        phase = section(NOVELTY, "## Phase B: Search and compare",
                        "## Phase C: Optional independent verification")
        for marker in ("keyword and semantic variants", "Topical", "Contextual",
                       "Methodological", "coverage gaps"):
            self.assertIn(marker, phase)
        self.assertIn("CONTINUE / VALIDATE_FIRST / PARK / STOP_CURRENT_VERSION",
                      read(CLAUDE_SKILLS / NOVELTY))

    def test_cross_skill_links_resolve_in_both_trees(self):
        checks = {
            BENCHMARK: (f"../{LITERATURE}#empirical-comparison-fields",),
            PLAN: (f"../{LITERATURE}#empirical-comparison-fields",
                   f"../{BENCHMARK}#trace-the-empirical-comparison-neighborhood"),
            NOVELTY: (f"../{LITERATURE}#multi-facet-queries", f"../{EVIDENCE}"),
        }
        for tree in (CLAUDE_SKILLS, CODEX_SKILLS):
            for source, links in checks.items():
                path = tree / source
                for link in links:
                    with self.subTest(tree=tree.name, source=source, link=link):
                        self.assertIn(f"]({link})", read(path))
                        relative_path, _, anchor = link.partition("#")
                        target = path.parent / relative_path
                        self.assertTrue(target.is_file())
                        if anchor:
                            headings = re.findall(r"^#{1,6} (.+)$", read(target), re.MULTILINE)
                            self.assertIn(anchor, [heading.lower().replace(" ", "-")
                                                   for heading in headings])

    def test_generated_codex_instructions_match_claude_sources(self):
        self.assertEqual(read(CLAUDE_SKILLS / EVIDENCE), read(CODEX_SKILLS / EVIDENCE))
        host_notice = "\nFollow the [active host rules](../shared-references/host-routing.md).\n"
        for path in (LITERATURE, BENCHMARK, PLAN, NOVELTY):
            with self.subTest(path=path):
                claude_body = read(CLAUDE_SKILLS / path).split("\n---\n", 1)[1]
                codex_body = read(CODEX_SKILLS / path).split("\n---\n", 1)[1]
                expected = claude_body.replace(".claude/skills/", ".agents/skills/")
                self.assertEqual(expected, codex_body.removeprefix(host_notice))


if __name__ == "__main__":
    unittest.main()
