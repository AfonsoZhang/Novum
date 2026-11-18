#!/usr/bin/env python3
"""debate-hub MCP server entrypoint (optional multi-agent debate plugin).

Default mode runs the MCP stdio server. Pass --list or --probe to inspect
detected agents and configured connectors from a terminal.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from debatehub.server import DebateHubApp, serve_stdio


def main() -> None:
    parser = argparse.ArgumentParser(description="debate-hub MCP server (optional multi-agent debate plugin)")
    parser.add_argument("--list", action="store_true", help="Print configured agents and detected local presets as JSON.")
    parser.add_argument("--probe", action="store_true", help="Also run safe protocol handshakes for enabled agents.")
    args = parser.parse_args()

    app = DebateHubApp()
    if args.list or args.probe:
        out = app.call_tool("debate_agents_list", {"probe": args.probe})
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return
    serve_stdio(app)


if __name__ == "__main__":
    main()
