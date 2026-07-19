---
name: delegate-claude
description: Launch and supervise one durable Claude Code implementation session from Codex. Use only when the user explicitly asks Codex to delegate, hand off, or run substantial work through Claude/Fable and wants Codex to monitor, intervene, and verify the result. Do not use for bounded architectural consultation; use consult-claude instead.
disable-model-invocation: true
---

# Delegate Claude

Delegate one substantial task to a full Claude Code session while Codex remains
responsible for supervision, user communication, verification, and final handoff.
Claude Code's background supervisor owns durable process and conversation state.

## Keep the lanes separate

Route by deliverable. If the deliverable is a memo about a synthesis Codex
already assembled, use `consult-claude` even when the user says "hand off": that
lane is fresh, tool-free, and never resumed. If the deliverable is a change in
the repository (discovery, implementation, tests, iteration, resumable work),
use this skill. Never weaken the consultation lane to obtain implementation
behavior.

Run at most one delegated Claude session for the current task unless the user
explicitly requests parallel delegation. A quiet session is not evidence that a
second session is needed.

## Build the execution packet

Gather the state Claude should not rediscover: relevant user direction, branch
and dirty-worktree state, source paths, diffs, decisions, checks already run,
and concrete proof targets. Give Claude room to revise the approach after
reading live context.

Make the packet cold-start complete:

```txt
Mission:
  The outcome and artifact Claude owns.

State:
  Branch, worktree, existing changes, checks, and unfinished work.

Sources:
  Files, diffs, ADRs, specs, logs, or documentation to inspect first.

Current read:
  What Codex currently believes and why; identify what is not settled.

Open questions:
  Decisions Claude should resolve or challenge from evidence.

Authority:
  The originating request's mutation scope. Do not push, deploy, merge, open a
  PR, contact people, or mutate external systems unless explicitly authorized.

Codex posture:
  Use /codex:rescue where it buys evidence, focused implementation, or
  independent verification. Do not ask a rescued Codex agent to delegate back
  to Claude.

Proof:
  Commands and evidence required before declaring the mission complete.

Final packet:
  Report the worktree path, branch and commits, changed files, diff summary,
  verification results, remaining risks, and every external action taken.
```

Claude inherits the user's task scope, not broader authority. Preserve private
context only when sending it to the locally authenticated Claude CLI is within
the user's request.

## Start one durable session

Resolve this skill's directory from its loaded `SKILL.md` path. Start the
launcher in the task's working directory:

```bash
bun <skill-dir>/scripts/delegate-claude.ts start --name <short-name>
```

Write the complete packet to stdin, then close it (`Ctrl-D` on a PTY; piping
the packet works the same). `--name` is optional; without it the launcher
generates a unique `codex-delegate-*` name. The launcher uses Fable, high
effort, and auto permission mode. It deliberately leaves normal Claude
configuration enabled so project instructions, skills, plugins, hooks, and
`/codex:rescue` remain available.

Capture the `DELEGATE_CLAUDE_JOB_ID=<id>` line. Do not invent another job
registry or status file. Background agents are a research preview, so the
launcher parses Claude's launch line and falls back to looking the session up
by name in `claude agents --json`; if it still exits without an ID, a session
may nevertheless be running. Check `claude agents` for the chosen name before
diagnosing, and never launch a duplicate speculatively.

Authority is enforced by layers, not magic: the packet's authority text
instructs the session, auto permission mode blocks actions that escalate beyond
the request, worktree isolation bounds repository damage, and Codex's final
verification catches the rest. A delegated session still holds the user's local
credentials, so treat external mutation authority as the packet's most
important line.

The launcher refuses to run inside Claude Code (`CLAUDECODE=1`). That variable
is the recursion boundary: a delegated worker sets it for every shell it
spawns, so `delegate-claude` or `consult-claude` invoked from inside the
worker, including through a rescued Codex, refuses itself.

## Watch without flooding context

Start the watcher in the task's working directory:

```bash
bun <skill-dir>/scripts/delegate-claude.ts watch <id>
```

Keep that command session attached. The watcher checks Claude's local
supervisor every 30 seconds, reports state changes, emits a heartbeat every
minute, and exits when the job finishes, fails, stops, disappears, or needs
input. Exit codes: 0 done, 10 blocked, 1 failed or stopped, 3 no such job, 4
three consecutive status-check failures (run `claude daemon status`, then
restart the watcher). Poll the watcher session without launching other Claude
commands while it is quiet. Update the user at least once per minute.

Supervision is resumable, not continuous. If Codex's turn ends or the watcher
session dies, the delegation is not lost: Claude's supervisor still owns the
job, and the next turn re-runs `watch <id>` or `status <id>` and continues.

To inspect a state directly or read recent terminal output:

```bash
bun <skill-dir>/scripts/delegate-claude.ts status <id>
claude logs <id>
```

Status polling is local and does not create another model turn. Read logs when
the state changes, when the session blocks, after several minutes without
useful progress, or at completion. Do not repeatedly inject identical logs into
Codex's context.

## Intervene deliberately

When the watcher reports a block, read `claude logs <id>` first to see the
question (logs are the session's raw terminal output). Codex may answer
repository facts it can verify and ordinary implementation choices already
implied by the task. Ask the user before answering product direction,
destructive actions, external writes, production operations, new authority, or
material scope expansion.

Deliver Codex's answer with the launcher:

```bash
bun <skill-dir>/scripts/delegate-claude.ts reply <id>
```

Write the answer to stdin, then close it. The launcher stops the session's
process and resumes the same conversation as a new background job with the
answer as the next user message; the session keeps its name and worktree.
Capture the new `DELEGATE_CLAUDE_JOB_ID=<id>` line and watch that ID from then
on. The superseded job stays listed as `stopped`; leave it alone, and never run
`claude rm` on it: that deletes the worktree the live session still uses.

`claude attach <id>` opens the session's full-screen terminal UI in the current
terminal; `Ctrl+Z` detaches while the session keeps running. Prefer attach when
the user intervenes directly or a live back-and-forth is genuinely needed;
prefer `reply` for machine-delivered answers.

Cancel with `claude stop <id>` when the user changes direction or the work is no
longer relevant. Use `claude respawn <id>` only to recover the same preserved
conversation after a confirmed process failure.

## Verify after Claude finishes

Treat Claude's `done` state as a handoff, not proof of completion.

Background sessions automatically move into a git worktree under
`.claude/worktrees/` before their first edit; a read-only mission may finish
without ever creating one. Once the move happens, the `status` record's `cwd`
is the worktree path, the final packet reports it, and `git worktree list`
confirms it (branch `worktree-<generated-name>`, locked).

1. Read the final logs and locate the reported worktree and branch.
2. Inspect the complete diff and repository status.
3. Verify the mission's tests and proof targets independently.
4. Check for unrelated edits and unauthorized commits, pushes, PRs, deploys, or
   external mutations.
5. Reconcile Claude's conclusions with local evidence.
6. Integrate or commit only when the originating request authorizes it.

If verification disproves Claude's completion claim, the session is healthy and
wrong, not failed: attach and continue the same conversation with the concrete
discrepancy, or finish the remainder locally. Do not respawn, and do not start
a second delegation for the same mission without telling the user.

A machine shutdown kills worker processes but keeps conversations. After a
reboot the job shows `failed` with a dead process; that is recoverable process
state, not a failed implementation. Read the logs first, then
`claude respawn <id>` to continue the same conversation.
