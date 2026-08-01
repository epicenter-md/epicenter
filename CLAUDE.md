@AGENTS.md

# Claude-specific notes

Codex is the second agent here, reached through the literal `/codex:rescue`
command (the `openai/codex-plugin-cc` plugin is installed). When work is worth
handing to another agent, send it there rather than to a built-in `Explore` or
`general-purpose` subagent: Codex is cheaper and better at searching, mapping
callers, reading diffs and history, auditing types, running verification, and
carrying a bounded edit, and that is a settled preference rather than a
per-task guess. Give it one job and the inputs it needs.

What comes back is evidence. Reading it is still yours: a confident Codex
answer that contradicts what you have already seen in the code is a reason to
look again, not a reason to defer.

`/codex:review`, `/codex:adversarial-review`, `/codex:transfer`,
`/codex:status`, `/codex:result`, and `/codex:cancel` are user-invoked and you
cannot call them. Suggest one when a second pass or a Codex handoff would help,
and relay what it returns faithfully before adding your own read.
