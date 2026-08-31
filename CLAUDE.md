@AGENTS.md

# Claude-specific notes

Codex is the primary continuity, judgment, execution, testing, and integration
owner for repository work. When the user explicitly asks for a Claude consult,
Claude is an advisory review lane: read the seeded context, explore related
repository evidence read-only when needed, and return tradeoffs, objections,
missing invariants, risks, and a strong recommendation.

A consult must not edit files, create a worktree, commit, publish, or become a
second executor. The starting paths in the consult brief are investigation
seeds, not a narrow boundary. Codex decides which feedback is valid and owns
any resulting changes.

`/codex:review`, `/codex:adversarial-review`, `/codex:transfer`,
`/codex:status`, `/codex:result`, and `/codex:cancel` remain user-invoked and
cannot be called automatically. Use them only when the user explicitly asks
for that separate Codex-plugin workflow.
