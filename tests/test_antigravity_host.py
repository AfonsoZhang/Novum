"""Antigravity-host adapter tests: skill view builder, project-local Codex MCP plugin, and host switching."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from build_antigravity import build as build_antigravity
from build_codex import build as build_codex
from configure_antigravity import configure as configure_antigravity


class AntigravityConfigTests(unittest.TestCase):
    def test_plugin_config_idempotent_and_preserves_user_settings(self):
        with tempfile.TemporaryDirectory(prefix='aris agy ') as temp:
            root = Path(temp)
            mcp_path = configure_antigravity(root)
            plugin_dir = root / '.agents' / 'plugins' / 'codex-reviewer'
            manifest = json.loads((plugin_dir / 'plugin.json').read_text(encoding='utf-8'))
            self.assertEqual(manifest['name'], 'codex-reviewer')
            first = json.loads(mcp_path.read_text(encoding='utf-8'))
            self.assertIn('codex', first['mcpServers'])
            self.assertEqual(first['mcpServers']['codex']['command'], 'python3')
            self.assertTrue(
                first['mcpServers']['codex']['args'][0].endswith('.agents/mcp-servers/codex-exec/server.py')
            )

            # Re-running is idempotent.
            configure_antigravity(root)
            self.assertEqual(json.loads(mcp_path.read_text(encoding='utf-8')), first)

            # Existing user customization is preserved verbatim.
            custom = {'mcpServers': {'codex': {'command': 'custom-codex', 'args': ['--mine']}}}
            mcp_path.write_text(json.dumps(custom, indent=2) + '\n', encoding='utf-8')
            configure_antigravity(root)
            self.assertEqual(json.loads(mcp_path.read_text(encoding='utf-8')), custom)


class AntigravityBuildTests(unittest.TestCase):
    def _seed_minimal_repo(self, root: Path) -> None:
        src = root / '.claude/skills/demo'
        src.mkdir(parents=True)
        (src / 'SKILL.md').write_text(
            '---\nname: demo\ndescription: Test skill\ndisable-model-invocation: true\n---\nScientific rule.\n',
            encoding='utf-8',
        )
        (src / 'script.py').write_text('print("ok")\n', encoding='utf-8')

        ref = root / '.claude/skills/shared-references'
        ref.mkdir(parents=True)
        (ref / 'reviewer-routing.md').write_text('Claude default routing\n', encoding='utf-8')
        (ref / 'split-review.md').write_text('Claude sub-agent audits; paper review (Codex)\n', encoding='utf-8')

        nf = root / '.claude/skills/paper-figure/references'
        nf.mkdir(parents=True)
        (nf / 'antigravity-generation.md').write_text('External MCP handoff\n', encoding='utf-8')
        (nf / 'imagegen-generation.md').write_text('Codex imagegen handoff\n', encoding='utf-8')

        (root / 'config/antigravity').mkdir(parents=True)
        (root / 'config/antigravity/host.md').write_text('Antigravity host contract\n', encoding='utf-8')
        (root / 'config/antigravity/reviewer-routing.md').write_text('Antigravity Codex routing\n', encoding='utf-8')
        (root / 'config/antigravity/antigravity-generation.md').write_text('Native image-generator\n', encoding='utf-8')

        (root / 'config/codex').mkdir(parents=True)
        (root / 'config/codex/host.md').write_text('Codex host contract\n', encoding='utf-8')
        (root / 'config/codex/reviewer-routing.md').write_text('Codex Claude routing\n', encoding='utf-8')
        (root / 'config/codex/imagegen-generation.md').write_text('Native Codex imagegen\n', encoding='utf-8')

    def test_generated_view_preserves_sources_and_guards_unowned_files(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self._seed_minimal_repo(root)
            original = (root / '.claude/skills/demo/SKILL.md').read_text(encoding='utf-8')

            build_antigravity(root)
            build_antigravity(root)

            self.assertEqual((root / '.claude/skills/demo/SKILL.md').read_text(encoding='utf-8'), original)
            skill = root / '.agents/skills/demo'
            skill_text = (skill / 'SKILL.md').read_text(encoding='utf-8')
            self.assertIn('../shared-references/host-routing.md', skill_text)
            self.assertIn('Scientific rule.', skill_text)
            self.assertEqual((skill / 'script.py').resolve(), root / '.claude/skills/demo/script.py')
            for reference in (
                'shared-references/reviewer-routing.md',
                'shared-references/split-review.md',
                'paper-figure/references/antigravity-generation.md',
            ):
                self.assertEqual((root / '.agents/skills' / reference).read_bytes(),
                                 (root / '.claude/skills' / reference).read_bytes())
            self.assertTrue((root / '.agents/skills/shared-references/antigravity-host.md').exists())
            self.assertTrue((root / '.agents/skills/research-auto/SKILL.md').exists())
            self.assertTrue((root / '.agents/skills/research-autopilot/SKILL.md').exists())

            # Unowned files are never overwritten.
            (root / '.claude/skills/new').mkdir()
            (root / '.claude/skills/new/file.md').write_text('new', encoding='utf-8')
            (root / '.agents/skills/new').mkdir()
            (root / '.agents/skills/new/file.md').write_text('user-owned', encoding='utf-8')
            with self.assertRaises(RuntimeError):
                build_antigravity(root)
            self.assertEqual((root / '.agents/skills/new/file.md').read_text(encoding='utf-8'), 'user-owned')

    def test_both_hosts_keep_the_same_files_and_migrate_legacy_ownership(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self._seed_minimal_repo(root)
            view = root / '.agents/skills'
            old = view / 'shared-references/codex-host.md'
            old.parent.mkdir(parents=True)
            old.write_text('legacy copy')
            legacy = root / '.codex/generated-files.json'
            legacy.parent.mkdir()
            legacy.write_text(json.dumps([old.relative_to(root).as_posix()]))
            build_antigravity(root)
            self.assertFalse(legacy.exists())
            def snapshot():
                return {p.relative_to(view): p.read_bytes() for p in view.rglob('*') if p.is_file()}
            expected = snapshot()
            for build in (build_codex, build_antigravity):
                build(root)
                self.assertEqual(snapshot(), expected)
                self.assertTrue((view / 'demo/agents/openai.yaml').is_file())
                for host in ('codex', 'antigravity'):
                    self.assertTrue((view / f'shared-references/{host}-host.md').is_file())


class AntigravityDocsAndInstallTests(unittest.TestCase):
    def test_root_docs_and_host_contracts_exist(self):
        for rel in (
            'GEMINI.md',
            'config/antigravity/host.md',
            'config/antigravity/reviewer-routing.md',
            'config/antigravity/antigravity-generation.md',
        ):
            self.assertTrue((ROOT / rel).exists(), rel)
        gemini_md = (ROOT / 'GEMINI.md').read_text(encoding='utf-8')
        self.assertIn('config/antigravity/host.md', gemini_md)
        self.assertIn('install.sh --host antigravity', gemini_md)
        install_sh = (ROOT / 'install.sh').read_text(encoding='utf-8')
        self.assertIn('claude|codex|antigravity', install_sh)
        self.assertIn('build_skills.py', install_sh)
        self.assertIn('configure_antigravity.py', install_sh)


if __name__ == '__main__':
    unittest.main()
