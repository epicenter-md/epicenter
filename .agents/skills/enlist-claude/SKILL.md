---
name: enlist-claude
description: Enlist one fresh, durable, fully capable Claude Code collaborator to pursue an outcome from its own judgment in an isolated worktree. Use when the user says consult Claude, have Claude execute, get Claude's view, or asks Codex to involve Claude in an independent investigation, challenge, review, prototype, or substantial mission. Do not use for an obvious bounded task Codex can finish directly or for a copy-paste prompt; use handoff for the latter.
---

# Enlist Claude

Enlist Claude with a desired outcome. Give it a fresh, durable, fully capable
isolated workspace, let it decide what the best contribution is, and integrate
nothing automatically.

Write the invitation as a natural message to a trusted collaborator. Say what
you want to become true, point to the repository context worth seeing, preserve
settled human values, and name any real hazard Claude cannot discover. Do not
classify the work as consultation, delegation, research, review, or
implementation. Do not prescribe a contribution type, plan, option menu,
investigation checklist, or report anatomy. Claude may inspect, challenge the
premise, find asymmetric refusals, prototype when useful, and carry its chosen
direction as far as the isolated environment allows.

The launcher always uses one standing envelope: a fresh high-effort background
session, normal project configuration, auto permission mode, a separate
worktree, local edits and commits, and durable continuation. Direct push and
pull-request publication commands are denied. Destructive actions, deploys,
other external writes, unrelated private-data access, and material expansion
beyond the user's request remain outside the mission.

## Start attached

Resolve this skill's directory from its loaded `SKILL.md` path. Start one
session in the task's working directory with a PTY, write the invitation to
stdin, and close it with `Ctrl-D`:

```bash
bun <skill-dir>/scripts/enlist-claude.ts start --name <short-name>
```

`start` prints `ENLIST_CLAUDE_JOB_ID=<id>` and stays attached. Its watcher polls
only local Claude job state; it does not prompt Claude or spend additional
Claude model tokens. Keep the command attached so completion or a real block
returns control to Codex without the user asking for another check. Use the
execution tool's ordinary wait mechanism rather than launching repeated status
commands. `status` and `watch` exist only to recover an interrupted watcher.

Read Claude's logs when the attached watcher reports a block, failure, or
completion. A block about an in-scope judgment is normally a cue to tell Claude
to make its best call. Continue only for new user direction or newly relevant
context:

```bash
bun <skill-dir>/scripts/enlist-claude.ts continue <id>
```

`continue` also stays attached and refuses to interrupt a working turn unless
`--interrupt` is explicit. Cancel with `claude stop <id>` when the mission is no
longer relevant; use `claude respawn <id>` only after a confirmed process
failure.

When Claude finishes, inspect its handoff, worktree, and complete diff. Verify
the result appropriate to the task, preserve meaningful disagreement, and
integrate only what the user's request authorizes. Treat the handoff as
evidence, not proof. Publication remains a separate user-authorized action.
