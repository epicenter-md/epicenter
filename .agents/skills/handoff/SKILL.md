---
name: handoff
description: 'Draft a compact, cold-start prompt for the user to copy and paste into a manually operated Claude Code session, with Claude as orchestrator and Codex available through /codex:rescue. Use only when the user explicitly asks for a prompt, manual handoff, continuation in another chat or machine, or invokes /handoff, or when automated delegation is unavailable and the user wants the fallback artifact. Do not use when Codex should launch and supervise Claude directly; use delegate-claude. Not for /goal lines or prompts shipped inside product code.'
argument-hint: "What should the next agent accomplish?"
metadata:
  author: epicenter
  version: '6.0'
---

# Claude Code Handoff

Write one copy-paste prompt for Claude Code. This skill is a manual transport
fallback: it never launches Claude or supervises execution. The prompt must be
cold-start so Claude can continue without this thread.

Default output: return only the prompt. If the user is designing or reviewing the handoff itself, a short note before the prompt is allowed.

## One Sentence

A handoff prompt gives Claude relevance-complete context, starting points, proof
targets, and a strong bias to use `/codex:rescue` creatively, while leaving
Claude free to rethink the plan and choose the delegation shape.

## Mental Model

Claude is the continuing agent:

```txt
Claude owns:
  orchestration
  context selection
  ambiguity and tradeoffs
  implementation direction
  `/codex:rescue` delegation choices
  final synthesis

Codex can help with:
  broad search and grep
  diff excavation
  exact file reads
  focused edits
  command execution
  tests and typechecks
  browser checks
  cleanup
  adversarial checks
  small prototypes
```

Do not pre-orchestrate the session. Prime Claude to use the literal `/codex:rescue` command, suggest seams when they are obvious, and explicitly allow Claude to revise, split, skip, or invent Codex calls after reading live context.

## Ground Before Writing

Gather the context the next agent should not have to rediscover.

For coding handoffs, usually collect:

```bash
git status --short --branch
git diff --name-status
git diff -- <relevant paths>
```

Also read the key files, tests, specs, ADRs, PR notes, or logs that ground the prompt. Include commands already run and their pass/fail status when useful.

For non-coding handoffs, gather the equivalent source material: docs, notes, links, current conclusions, open questions, and the artifact the next agent should produce.

Skip heavy grounding only for obviously tiny handoffs or when the user asks for a fast conversational prompt.

## Prompt Contents

Include the live context needed to think from the same reality as the current
agent. Do not enforce artificial brevity: a small handoff should fit in 12 to 20
dense lines, while an ambitious or high-stakes handoff should be as complete as
the mission requires. Exclude unrelated transcript bulk, not relevant evolution
or user reactions.

Cover what helps Claude start:

```txt
Mission:
  One outcome and the artifact wanted.

State:
  Branch, dirty worktree, staged files, checks run, and what remains open.

Source paths:
  Exact files, diffs, commands, PRs, specs, ADRs, or notes to inspect first.

Current read:
  What seems true, recommendations so far, and why. Avoid calling these settled unless an ADR, code path, or explicit user decision makes them settled.

Evolution:
  User reactions, rejected approaches, and decisions that explain the current
  direction.

Recognition criteria:
  What the user will recognize as right beyond mechanical test completion.

Open questions:
  What Claude should decide or re-check. Invite challenge when code, tests, ADRs, or product constraints contradict the current read.

Watch-outs:
  Only real hazards: dirty user work, destructive git, production or deploy actions, migrations, security, licensing/package boundaries, obsolete paths to avoid, or explicit user non-goals.

Codex posture:
  Tell Claude to look actively for work worth delegating through `/codex:rescue`. For substantial work, list candidate seams, but make them examples, not a queue.

Proof and stop:
  Likely verification commands or evidence targets, plus where to stop.
```

## Codex Posture

Always prime Claude that Codex is available through the literal `/codex:rescue` command. For tiny handoffs, one sentence is enough:

```txt
Use /codex:rescue where it buys speed, breadth, focused execution, or independent verification.
```

For substantial coding, review, debugging, migration, or verification work, suggest candidate `/codex:rescue` seams. Name the command in the handoff so Claude does not have to infer it from “Codex.” Shape seams as options:

```txt
Candidate Codex seams:
  - Diff excavation: inspect <range/paths>; return keep/rewrite/drop map with risks.
  - Focused implementation: edit <bounded paths> for <one wave>; return changed files, diff summary, risks, and verification.
  - Verification: run <commands>; return pass/fail output and likely next fix.
```

Rules for candidate Codex seams:

- one job, bounded sources, one deliverable, clear stop condition
- exact inputs when known
- commit-sized waves for implementation
- disposable worktree or clearly named branch when edits are non-trivial
- result packets include changed files, diffs, command output, risks, and recommendations
- Claude may revise, split, skip, or add jobs after reading live context

## What To Avoid

Do not turn the handoff into:

```txt
an execution script
an unchallengeable decision record
a mandatory Codex job queue
a rigid constraints list
a duplicate spec or pasted diff dump
a transcript summary with no source paths
```

Prefer current read over settled decision. Prefer watch-out over prohibition. Prefer candidate seam over commandment.

## Stop Condition

The recipient should know what counts as done:

```txt
Stop after:
  a review memo
  a PR-ready diff
  a clean implementation branch
  a verified command output set
  a blocker list with the smallest remaining decisions
```

For a `/goal` one-liner, use [agent-goal](../agent-goal/SKILL.md). A human-facing progress summary is an ordinary response grounded in the branch and session state, not a separate handoff artifact.
