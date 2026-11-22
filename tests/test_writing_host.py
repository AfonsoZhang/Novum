import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from build_antigravity import build as build_antigravity
from build_codex import build as build_codex


class WritingHostTests(unittest.TestCase):
    def test_writing_routes_survive_both_host_switches(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name in ('.claude', 'config'):
                (root / name).symlink_to(ROOT / name, target_is_directory=True)
            source = root / '.claude/skills'
            view = root / '.agents/skills'
            route = Path('shared-references/writing-host.md')
            expected = None
            for build in (build_codex, build_antigravity, build_codex):
                build(root)
                with self.subTest(host=build.__module__):
                    tree = {p.relative_to(view): p.read_bytes() for p in view.rglob('*') if p.is_file()}
                    if expected is None:
                        expected = tree
                    self.assertEqual(tree, expected)
                    rules = (view / route).read_text()
                    self.assertEqual(rules, (source / route).read_text())
                    for host in ('codex', 'antigravity'):
                        contract = f'../../../config/{host}/host.md'
                        self.assertIn(f'({contract})', rules)
                        self.assertTrue(((view / route).parent / contract).is_file())
                    for name in ('paper-writer', 'paper-polish', 'intro-drafter'):
                        entry = Path(name) / 'SKILL.md'
                        installed = (view / entry).read_text()
                        self.assertIn(f'(../{route})', installed)
                        self.assertEqual(installed, (source / entry).read_text())

    def test_installers_preserve_both_optional_routes_and_existing_settings(self):
        with tempfile.TemporaryDirectory(prefix='research hosts ') as temp:
            root = Path(temp)
            for name in ('config', '.claude', '.mcp.json.example'):
                (root / name).symlink_to(ROOT / name, target_is_directory=(ROOT / name).is_dir())
            shutil.copytree(ROOT / 'scripts', root / 'scripts')
            shutil.copy(ROOT / 'install.sh', root)
            adapter = root / 'my writer.py'
            adapter.touch()
            env = dict(os.environ, ANTIGRAVITY_MCP_SERVER=str(adapter), WITH_DIAGRAMS='0')
            for host in ('antigravity', 'codex', 'claude', 'codex', 'antigravity'):
                subprocess.run(['bash', str(root / 'install.sh'), '--host', host], cwd=root,
                               env=env, capture_output=True, check=True)
            codex = (root / '.codex/config.toml').read_text()
            self.assertEqual(codex.count('[mcp_servers.antigravity]'), 1)
            self.assertNotIn('claude_reviewer', codex)
            self.assertIn(str(adapter), codex)
            claude = json.loads((root / '.mcp.json').read_text())['mcpServers']
            self.assertIn('codex', claude)
            self.assertEqual(claude['antigravity']['args'], [str(adapter)])
            plugin = root / '.agents/plugins/codex-reviewer/mcp_config.json'
            self.assertIn('codex', json.loads(plugin.read_text())['mcpServers'])
            self.assertEqual(json.loads((root / '.tools/reviewer.json').read_text())['backend'], 'native')
