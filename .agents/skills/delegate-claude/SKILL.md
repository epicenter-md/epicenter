---
name: delegate-claude
description: Launch and supervise one durable Claude Code session that independently leads and implements a substantial mission. Use when the user asks Codex to have Claude execute or hand off the work, or when an ambitious, exploratory, multi-file task would benefit from a long-horizon collaborator. Do not use for an obvious bounded fix or to produce a copy-paste prompt; use handoff instead.
---

# Delegate Claude

Invite Claude to lead a substantial piece of work as a collaborator. Tell it
what you want to become true, point it at the context worth seeing, and name
only the boundaries that are real. Do not send a governance document, a
pre-chosen plan, or a menu of decisions for Codex to make.

The invitation should feel like a useful message to a trusted maintainer. Add
the current branch, worktree state, or proof target only when it helps Claude
act well. Claude makes the in-scope calls, including product, architecture, and
local implementation choices. It may reframe the work, discard an inherited
approach, and explain the choice in its handoff. Do not interrupt it to decide
ordinary alternatives.

Use `consult-claude` for a one-shot read-only investigation. Use this skill
when Claude should investigate, decide, and carry the work through. Use
`handoff` only for a manual copy-paste prompt.

## Boundaries that remain real

Local work and local commits are in scope. Destructive actions, external
writes, unrelated private-data access, and material expansion beyond the user's
request are not. Pushing, opening or merging a pull request, deploying, and
other external writes require separate user authorization after verification.

The launcher denies common direct forms of `git push`, `gh pr create`, and
`gh pr merge` on every launch and resume. It is not a shell or network sandbox:
deploys, APIs, and other external-write routes still rely on Claude following
the invitation and on later verification.

## Run and watch

Resolve this skill's directory from its loaded `SKILL.md` path, then start one
durable session in the task's working directory:

```bash
bun <skill-dir>/scripts/delegate-claude.ts start --name <short-name>
```

Write the invitation to stdin and close it (`Ctrl-D` on a PTY). The launcher
uses high effort, normal project configuration, auto permission mode, and a
separate worktree. Capture `DELEGATE_CLAUDE_JOB_ID=<id>`; if it is absent after
a successful launch, inspect `claude agents` for the chosen name before trying
again.

Watch the session with:

```bash
bun <skill-dir>/scripts/delegate-claude.ts watch <id>
```

Read logs on state changes, blocks, long silence, or completion. A block about
an in-scope choice is a cue to tell Claude to make its best call, not a cue to
make the choice for it. Continue only for new user direction or newly granted
authority:

```bash
bun <skill-dir>/scripts/delegate-claude.ts continue <id>
```

`continue` refuses to interrupt a working turn unless `--interrupt` is
explicit. Cancel with `claude stop <id>` when the work is no longer relevant;
use `claude respawn <id>` only after a confirmed process failure.

When Claude finishes, inspect its worktree and complete diff, run the relevant
proof independently, and check for unauthorized external actions. Treat the
handoff as evidence, not proof. Publishing remains a separate user-authorized
action.
