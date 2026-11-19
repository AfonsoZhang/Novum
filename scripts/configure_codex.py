#!/usr/bin/env python3
"""Register an explicitly supplied Antigravity MCP server for a writing host."""
import argparse
import json
import os
from pathlib import Path
import re


def configure(root, adapter=None, host='codex'):
    if not adapter:
        return
    script = Path(adapter).expanduser().resolve(strict=True)
    if not script.is_file():
        raise ValueError(f'Expected an Antigravity MCP Python entry point: {script}')
    if host == 'claude':
        path = root / '.mcp.json'
        config = json.loads(path.read_text()) if path.exists() else {}
        servers = config.setdefault('mcpServers', {})
        if 'antigravity' not in servers:
            servers['antigravity'] = {'type': 'stdio', 'command': 'python3', 'args': [str(script)]}
            path.write_text(json.dumps(config, indent=2, ensure_ascii=False) + '\n')
    else:
        path = root / '.codex/config.toml'
        text = path.read_text() if path.exists() else ''
        if not re.search(r'''^\s*\[mcp_servers\.(?:antigravity|"antigravity"|'antigravity')\]''', text, re.M):
            path.parent.mkdir(exist_ok=True)
            with path.open('a') as stream:
                stream.write('\n[mcp_servers.antigravity]\ncommand = "python3"\n'
                             f'args = [{json.dumps(str(script))}]\ntool_timeout_sec = 660\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', choices=['claude', 'codex'], default='codex')
    args = parser.parse_args()
    configure(Path(__file__).resolve().parents[1], os.environ.get('ANTIGRAVITY_MCP_SERVER'), args.host)
