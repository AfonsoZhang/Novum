#!/usr/bin/env python3
"""Optional setup helper for the debate-hub MCP plugin (never enabled by default).

Usage:
  python3 scripts/enable_debate_hub.py --init
  python3 scripts/enable_debate_hub.py --snippets
  python3 scripts/enable_debate_hub.py --register claude
  python3 scripts/enable_debate_hub.py --register codex
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER_SCRIPT = ROOT / ".agents" / "mcp-servers" / "debate-hub" / "server.py"
EXAMPLE_CONFIG = ROOT / "config" / "debate-hub.example.json"
LOCAL_CONFIG = ROOT / ".tools" / "debate-hub.json"


def init_config(root: Path = ROOT) -> Path:
    cfg_path = root / ".tools" / "debate-hub.json"
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    if cfg_path.exists():
        print(f"Preserved existing config: {cfg_path}")
        return cfg_path
    shutil.copyfile(root / "config" / "debate-hub.example.json", cfg_path)
    print(f"Created {cfg_path} (all active agents start disabled; set enabled=true for those you want)")
    return cfg_path


def register_claude(root: Path = ROOT) -> Path:
    mcp_path = root / ".mcp.json"
    if mcp_path.exists():
        data = json.loads(mcp_path.read_text(encoding="utf-8"))
    else:
        data = {"mcpServers": {}}
    servers = data.setdefault("mcpServers", {})
    if "debate-hub" in servers:
        print(f"Preserved existing MCP configuration: debate-hub in {mcp_path}")
        return mcp_path
    servers["debate-hub"] = {
        "type": "stdio",
        "command": "python3",
        "args": [str(root / ".agents" / "mcp-servers" / "debate-hub" / "server.py")],
    }
    mcp_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Registered debate-hub in {mcp_path}")
    return mcp_path


def register_codex(root: Path = ROOT) -> Path:
    toml_path = root / ".codex" / "config.toml"
    toml_path.parent.mkdir(parents=True, exist_ok=True)
    text = toml_path.read_text(encoding="utf-8") if toml_path.exists() else ""
    if re.search(r"""^\s*\[\s*mcp_servers\s*\.\s*(["']?)debate[-_]hub\1\s*\]""", text, re.M):
        print(f"Preserved existing MCP configuration: debate-hub in {toml_path}")
        return toml_path
    script = str(root / ".agents" / "mcp-servers" / "debate-hub" / "server.py")
    text += (
        '\n[mcp_servers."debate-hub"]\n'
        'command = "python3"\n'
        f"args = [{json.dumps(script)}]\n"
        "startup_timeout_sec = 30\n"
        "tool_timeout_sec = 900\n"
    )
    toml_path.write_text(text, encoding="utf-8")
    print(f"Registered debate-hub in {toml_path}")
    return toml_path


def print_snippets(root: Path = ROOT) -> None:
    script = str(root / ".agents" / "mcp-servers" / "debate-hub" / "server.py")
    print("# Claude Code / Cursor / generic MCP JSON (.mcp.json):")
    print(json.dumps({
        "mcpServers": {
            "debate-hub": {
                "type": "stdio",
                "command": "python3",
                "args": [script],
            }
        }
    }, indent=2))
    print("\n# Codex (.codex/config.toml):")
    print(
        '[mcp_servers."debate-hub"]\n'
        'command = "python3"\n'
        f"args = [{json.dumps(script)}]\n"
        "startup_timeout_sec = 30\n"
        "tool_timeout_sec = 900\n"
    )
    print("# Gemini CLI:")
    print(f"gemini mcp add debate-hub python3 {script}\n")
    print("# Antigravity CLI (agy):")
    print(f"agy mcp add debate-hub -- python3 {script}\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="Opt-in setup helper for debate-hub MCP plugin")
    parser.add_argument("--init", action="store_true", help="Copy config/debate-hub.example.json to .tools/debate-hub.json (never overwrites)")
    parser.add_argument("--snippets", action="store_true", help="Print MCP registration snippets for Claude, Codex, Gemini, Agy, Cursor")
    parser.add_argument("--register", choices=["claude", "codex"], help="Register debate-hub in project .mcp.json or .codex/config.toml")
    args = parser.parse_args()

    if not (args.init or args.snippets or args.register):
        parser.print_help()
        sys.exit(2)
    if args.init:
        init_config()
    if args.register == "claude":
        init_config()
        register_claude()
    elif args.register == "codex":
        init_config()
        register_codex()
    if args.snippets:
        print_snippets()


if __name__ == "__main__":
    main()
