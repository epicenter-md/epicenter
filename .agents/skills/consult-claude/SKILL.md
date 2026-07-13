---
name: consult-claude
description: Give Claude one fresh, read-only adversarial consultation on Codex's current synthesis. Use only when the user explicitly invokes $consult-claude or unmistakably asks Codex to consult Claude on an uncompromising greenfield vision, architecture direction, or other bounded decision after Codex has gathered the relevant evidence and directional data.
disable-model-invocation: true
---

# Consult Claude

The consult-claude skill gives Claude one explicitly requested opportunity to
attack Codex's decision-complete synthesis. Codex owns the user dialectic,
packet, verification, reconciliation, and final judgment. Claude returns one
adversarial memo. The runner keeps that fresh, tool-free consultation observable
and bounded.

## Build the packet

Read the evidence Claude should not have to rediscover. Include content rather
than only paths because Claude has no file tools. Preserve selected verbatim
directional data when Codex's summary would smooth away the user's taste.

Start every packet with this mandate:

```txt
Mandate:
  Attack the synthesis as a whole. Surface inherited assumptions and hidden
  compromises, articulate the strongest rival, and propose further collapse.
  Return one decisive memo. Do not ask the user questions, inspect the
  repository, use tools, implement, or continue the task.
```

Then make the packet cold-start complete:

```txt
Mission:
  The bounded subject or design problem.

Evolution:
  How the vision changed during the Codex-user dialectic.

Directional data:
  Selected user reactions, rejected framings, and recognition criteria.

Evidence:
  Relevant excerpts, diffs, command output, paths, and durable decisions.

Current synthesis:
  Codex's positive model and reasoning.

Competing case:
  The strongest rival vision or objection.

Tensions:
  What remains uncertain or may still hide an inherited constraint.

Constraints:
  Product promises, ownership boundaries, security limits, and refusals.

Deliverable:
  The memo shape that will help Codex reconcile the challenge.

Stop:
  Answer this bounded problem. Do not implement or expand the task.
```

Decision-complete does not mean short. Include the conversational history that
explains the vision, but do not dump unrelated repository context or make
Claude reconstruct facts Codex can establish locally.

## Run one attached consultation

Prerequisites: Bun and a current, authenticated Claude CLI on macOS or Linux.
Resolve this skill's directory from its loaded `SKILL.md` path. Start
`scripts/consult-claude.ts` in the task's working directory with a PTY and keep
the returned command session attached. The runner switches terminal input to
raw, non-echoing mode. Write the complete packet to stdin, then send the EOT
character (`Ctrl-D`). The runner accepts no prompt arguments and creates no
files.

The runner starts Claude in safe mode with no tools, browser, project discovery,
or persisted session. It inherits the environment needed for local
authentication. Do not add tools without revisiting that trust boundary.

If the runtime blocks export of private context, do not silently weaken the
packet. Explain the boundary. Prefer routing the scoped network approval to the
user. If the user chooses a sanitized consultation instead, remove private
identifiers, paths, code, commits, and verbatim conversation, then run from a
neutral temporary directory.

## Wait patiently

- Keep the returned command session attached and poll that same session.
- Treat silence as slow, not hung; the runner emits a heartbeat every minute.
- Update the user at least once per minute with elapsed time.
- Continue through provider retries and rate limits.
- Never launch a duplicate because the consultation is quiet.
- Cancel when the user changes direction or the consultation is no longer
  relevant. Let the runner terminate the process group after 30 minutes.

Do not add detached jobs, status files, session resume, or lifecycle commands.
Codex's command session already owns waiting and cancellation.

## Reconcile the memo

1. Report Claude's strongest argument accurately.
2. Separate Claude's evidence from its opinion.
3. Verify every material claim against local files or authoritative sources.
4. Explain what survives verification and what changes in Codex's synthesis.
5. Put the revised synthesis back into the user dialectic.

Each consultation is fresh. A later checkpoint may request another consultation
for a genuinely new synthesis, but never resume a Claude session or let Claude
accumulate hidden context.
