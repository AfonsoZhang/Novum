"""Verify empirical ideation patterns, four-axis collision checks, and Idea Card links."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
CLAUDE_SKILLS = ROOT / '.claude/skills'
AGENTS_SKILLS = ROOT / '.agents/skills'


class IdeationPatternsAndSuiteTests(unittest.TestCase):
    def test_ideation_patterns_catalog_and_evidence_exist(self):
        patterns = (CLAUDE_SKILLS / 'research-companion/principles/ideation-patterns.md').read_text()
        self.assertIn('Reject Paradox', patterns)
        self.assertIn('shared topic-selection policy', patterns)
        for idx in range(1, 16):
            self.assertIn(f'| {idx} |', patterns)
        evidence = (CLAUDE_SKILLS / 'research-companion/principles/ideation-evidence.md').read_text()
        self.assertIn('ResearchStudio-Idea', evidence)
        self.assertIn('ideation-patterns.md', evidence)

    def test_cross_skill_links_resolve_in_claude_and_codex_views(self):
        checks = [
            ('brainstorming-research-ideas/SKILL.md', '../research-companion/principles/ideation-patterns.md'),
            ('idea-evaluator/SKILL.md', '../research-companion/principles/ideation-patterns.md'),
            ('research-companion/SKILL.md', 'principles/ideation-patterns.md'),
        ]
        for base in (CLAUDE_SKILLS, AGENTS_SKILLS):
            for skill_rel, target_rel in checks:
                skill_path = base / skill_rel
                text = skill_path.read_text()
                self.assertIn(target_rel, text, f'{skill_path} missing link {target_rel}')
                self.assertTrue((skill_path.parent / target_rel).resolve().exists(),
                                f'Unresolved link {target_rel} from {skill_path}')

    def test_novelty_check_has_four_axis_collision_and_preserves_four_decisions(self):
        text = (CLAUDE_SKILLS / 'novelty-check/SKILL.md').read_text()
        for marker in ('Problem Framing', 'Key Insight', 'Core Mechanism', 'Application Domain / Setting',
                       'Differentiation strategy', 'CONTINUE / VALIDATE_FIRST / PARK / STOP_CURRENT_VERSION'):
            self.assertIn(marker, text)

    def test_research_companion_has_evidence_readiness_and_idea_card(self):
        text = (CLAUDE_SKILLS / 'research-companion/SKILL.md').read_text()
        for marker in ('Evidence readiness check', 'Session Summary — Idea Card',
                       'Contrastive Failure Modes', 'Kill Switch (Pre-Registered Refutation)'):
            self.assertIn(marker, text)

    def test_research_lit_has_openreview_dblp_crossref_and_evidence_readiness(self):
        text = (CLAUDE_SKILLS / 'research-lit/SKILL.md').read_text()
        for marker in ('OpenReview', 'DBLP', 'Crossref', 'Evidence Readiness Summary'):
            self.assertIn(marker, text)


if __name__ == '__main__':
    unittest.main()
