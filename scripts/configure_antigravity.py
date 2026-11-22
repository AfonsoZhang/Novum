#!/usr/bin/env python3
"""Configure project-local Antigravity MCP plugin for Codex review; preserve user config."""
import json
from pathlib import Path


def configure(root: Path) -> Path:
    plugin_dir = root / '.agents' / 'plugins' / 'codex-reviewer'
    plugin_dir.mkdir(parents=True, exist_ok=True)

    manifest_path = plugin_dir / 'plugin.json'
    if not manifest_path.exists():
        manifest_path.write_text(
            json.dumps({'name': 'codex-reviewer', 'version': '1.0.0'}, indent=2) + '\n',
            encoding='utf-8',
        )

    mcp_path = plugin_dir / 'mcp_config.json'
    if mcp_path.exists():
        data = json.loads(mcp_path.read_text(encoding='utf-8'))
    else:
        data = {'mcpServers': {}}
    servers = data.setdefault('mcpServers', {})
    if 'codex' in servers:
        print(f'Preserved existing MCP configuration: codex in {mcp_path}')
        return mcp_path

    script = str(root / '.agents' / 'mcp-servers' / 'codex-exec' / 'server.py')
    servers['codex'] = {
        'command': 'python3',
        'args': [script],
    }
    mcp_path.write_text(json.dumps(data, indent=2) + '\n', encoding='utf-8')
    print(f'Configured {mcp_path}')
    return mcp_path


if __name__ == '__main__':
    configure(Path(__file__).resolve().parents[1])
