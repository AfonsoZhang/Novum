# Writing on Claude Code, Codex and Antigravity

The application running the task owns the manuscript. Claude Code follows
`CLAUDE.md`, Codex follows the [Codex host contract](../../../config/codex/host.md),
and Antigravity follows the [Antigravity host contract](../../../config/antigravity/host.md).
Use the session identity even when several CLIs or MCP servers are installed.

Draft and polish on the current host by default. When the author selects an
external writer, use Antigravity. On Antigravity, work directly. On Claude
Code or Codex, discover the Antigravity MCP tool in the current session and
send the bounded assignment. A host with an authenticated `agy` CLI can also
send the approved text to Antigravity in print mode when the author allows that
transport. If Antigravity is unavailable, report that and use the host for an
authorized local draft. If the author requires Antigravity
specifically, report the missing route before treating any draft as delivered.

For drafting, send the applicable writing skill, section objective, primary
materials allowed for this task and approved evidence. Ask for draft prose
with traceable claims. For polishing, send the authorized passage, terminology,
numbers and constraints on claim strength. Request clean text and reasons for
the edits. Confirm the author's authorization before transmitting unpublished
material. The sender checks the returned text against the originals, verifies
numbers and citations, and decides which edits to adopt. A receiving
Antigravity session completes its assignment directly. Report the actual tool
and any model identity it exposes.
