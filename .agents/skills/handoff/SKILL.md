---
name: handoff
description: 'Draft a compact, cold-start prompt for the user to copy and paste into a manually operated Claude Code session, with Claude leading the mission and Codex optionally available through /codex:rescue. Use only when the user explicitly asks for a prompt, manual handoff, continuation in another chat or machine, or invokes /handoff, or when direct Claude consultation is unavailable and the user wants the fallback artifact. Do not use when the active agent should run a context-rich, read-only Claude consultation; use consult-claude. Not for /goal lines or prompts shipped inside product code.'
argument-hint: "What should the next agent accomplish?"
metadata:
  author: epicenter
  version: '7.0'
---

# Claude Code Handoff

Write one prompt the user can paste into a fresh Claude Code session. This
skill is a transport fallback: it never launches Claude and never supervises
execution. Return only the prompt. If the user is designing or reviewing the
handoff itself, a short note before it is fine.

The recipient cannot see this conversation. Everything it needs in order to
think from the same reality has to be in the prompt, and everything else is
noise.

Claude leads the mission and chooses its verification. Codex is an optional
`/codex:rescue` capability for a bounded need, not a default supervisor or
decision-maker.

## Ground it first

Look before writing. For coding work that usually means:

```bash
git status --short --branch
git diff --name-status
git diff -- <relevant paths>
```

Then read the files, tests, specs, ADRs, or logs the prompt will point at, and
note which commands have already been run and whether they passed. For
non-coding work, gather the equivalent source material. Skip the grounding pass
only for something obviously small.

## Write it

Carry the mission and the artifact wanted, the live state, the exact paths
worth opening first, what you currently believe and why, and what is still open
for the recipient to decide or re-check.

Two things are easy to leave out and expensive to lose: the evolution that
explains the current direction (what the user reacted to, what was tried and
dropped), and what the user will recognize as right beyond a passing test run.

Name real hazards: dirty user work, destructive git, deploys, migrations,
security, licensing boundaries, dead paths to avoid, explicit non-goals. Leave
out hazards that are merely conceivable.

Let length follow the mission. A small handoff is 12 to 20 dense lines; an
ambitious one runs as long as it needs to. Cut transcript bulk, not the
reasoning that got you here.

Say that Codex is available through the literal `/codex:rescue` command, since
"Codex" alone does not name the command. For substantial work, suggest a couple
of concrete seams (a diff to excavate, a wave to implement, a verification to
run), and say plainly that they are examples.

## The posture that makes it work

Prefer current read over settled decision. Prefer watch-out over prohibition.
Prefer candidate seam over commandment.

The recipient is picking the work up, not executing a script. It should be free
to reread the code, disagree with your conclusions, throw out the plan, and
choose its own delegation shape. Say what you think is true and why, and do not
promote that to settled unless an ADR, a code path, or an explicit user
decision made it settled.

Close with the likely verification commands or evidence targets, and with what
counts as done: a review memo, a PR-ready diff, a clean implementation branch,
a verified command set, or a blocker list with the smallest remaining
decisions.

For a one-line `/goal`, use [agent-goal](../agent-goal/SKILL.md). A progress
summary for the user is an ordinary response grounded in branch and session
state, not a handoff artifact.
