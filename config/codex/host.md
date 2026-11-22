# Codex host contract

This contract adapts host mechanics only and takes precedence over Claude-specific
examples in shared skills. Keep all scientific policies, stages, artifact formats,
claim preservation, scope boundaries and the explicit topic-approval checkpoint.

- Codex runs the task. Use a fresh Codex subagent for review. Write and polish directly unless the author selects Antigravity for the task.

- Invoke skills as `$skill-name`; interpret a user's `/skill-name` as the same
  explicit request. `$research-auto` explicitly activates automatic mode for the
  current task only. Loading these files never activates it.
- `.claude/agents/*.md` are role instructions, not registered Codex agent types.
  When delegation is authorized, read the role file and pass its contents, scope,
  sources, writable files and acceptance criteria to the available spawn tool.
  Resolve role references to `.claude/skills/` through the generated
  `.agents/skills/` view so delegated Codex work retains this host contract.
  Use a fresh context for independent checks (e.g. `fork_turns: "none"` when
  supported). Send follow-ups to the returned ID; wait for actual completion.
  Never invent `subagent_type`, `TeamCreate`, `SendMessage` or worktree flags.
  If delegation is absent, report that gap; serial self-check is not independent QA.
- Replace Claude Read/Grep/Glob/Bash/Write/Edit with the actual file, search,
  shell and patch tools. Store untrusted text using a file/patch tool, never shell
  interpolation. Discover deferred tools through the actual runtime registry.
- For questions use an available asynchronous input tool and continue independent
  work. Use a blocking input tool only in modes where it is available. Otherwise
  ask in the final response and await the next user message. Silence, timeout or
  dismissal never supplies topic approval or other required authority.
- Background shell processes do not imply model wakeup: retain process IDs and
  poll using the runtime's wait tool. Do not assume Claude Monitor, ScheduleWakeup,
  `/loop`, background flags or automatic continuation after a session ends.
- Apply the [shared reviewer routing](../../.claude/skills/shared-references/reviewer-routing.md) and [writing rules](../../.claude/skills/shared-references/writing-host.md).

- Native image generation stays on Codex: read the installed imagegen skill and
  use the current session's image tool.
  Preserve the original provider selection, figure QA and unavailable-tool rules.
- Resolve RESEARCH_ROOT from the root AGENTS.md location, not a child project's
  cwd. Commands must substitute the absolute root if the variable is unset.
