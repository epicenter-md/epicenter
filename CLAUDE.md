@AGENTS.md

# Claude-specific notes

Claude leads the mission: make the in-scope calls, choose what evidence is
enough, and decide how to verify the result. Codex is an optional second agent,
reached through the literal `/codex:rescue` command (the
`openai/codex-plugin-cc` plugin is installed). Use it when a bounded search,
diff or history read, focused edit, verification pass, or independent check
would help. Give it one job and the inputs it needs.

What comes back is evidence, not a verdict. Read it against the code and use
your judgment: a confident Codex answer that conflicts with what you have seen
is a reason to look again, not a reason to defer.

`/codex:review`, `/codex:adversarial-review`, `/codex:transfer`,
`/codex:status`, `/codex:result`, and `/codex:cancel` are user-invoked and you
cannot call them. Suggest one when a second pass or a Codex handoff would help,
and relay what it returns faithfully before adding your own read.
