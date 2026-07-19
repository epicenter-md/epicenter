---
name: consult-claude
description: Give Claude one fresh, read-only adversarial memo on Codex's grounded synthesis. Use when the user asks Codex to consult Claude or when an independent reasoning trajectory would materially reduce risk in a high-stakes, ambiguous, architectural, product, planning, or clean-break decision; Codex may invoke it autonomously after forming an evidence-backed read. Do not use for implementation, an obvious bounded decision, or a continuing Claude conversation.
---

# Consult Claude

The consult-claude skill gives Claude one fresh opportunity to attack Codex's
decision-complete synthesis. The user owns product direction. Codex owns the
user dialectic, escalation decision, packet, verification, reconciliation, and
final recommendation. Claude owns one strong adversarial memo. The runner keeps
that consultation tool-free, observable, and bounded.

Codex may escalate autonomously when getting the judgment wrong would cost
substantially more than the additional latency and quota. Announce the
consultation and why it earns the escalation before starting it. Do not consult
to avoid forming a grounded position first.

## Build the packet

Read the evidence Claude should not have to rediscover. Include content rather
than only paths because Claude has no file tools. Preserve selected verbatim
directional data when Codex's summary would smooth away the user's taste.

Start every packet with this mandate:

```txt
Mandate:
  Attack the synthesis as a whole. Surface inherited assumptions and hidden
  compromises, articulate the strongest rival, test the important failure
  modes, and recommend the best direction. Propose collapse or a clean break
  when the evidence earns it, not as a default. Return one decisive memo. Do
  not ask the user questions, inspect the repository, use tools, implement, or
  continue the task.
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

Decision-complete does not mean short. Give Claude relevance-complete context:
the objective, evolution, user reactions, rejected ideas, evidence, constraints,
and current reasoning needed to think from the same reality as Codex. Do not
starve the packet into a conclusion-only summary or make Claude reconstruct
facts Codex can establish locally. Exclude only context that is unrelated to the
task.

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

Sending the packet to the locally authenticated Claude CLI is an export of its
contents. Within the task, Claude may receive the same relevant context Codex
has, including private repository content and conversational history. Ask the
user before crossing the task boundary into unrelated private material,
credentials, personal data, or broader external systems. If the runtime blocks
an in-scope export, do not silently weaken the packet. Explain the boundary and
route any required approval to the user.

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

1. State Claude's strongest recommendation accurately.
2. Separate Claude's evidence from its opinion.
3. Verify every material claim against local files or authoritative sources.
4. State where Codex agrees, disagrees, or needs more evidence.
5. Resolve obvious evidence-dominated consequences without ceremony.
6. Bring genuine product, promise, ownership, or taste forks to the user.
7. Put the revised synthesis back into the user dialectic.

Do not smooth genuine disagreement into a compromise. When a product decision
remains, present Claude's recommendation, Codex's read, and the concrete choice
the user owns.

Each consultation is fresh. A later checkpoint may request another consultation
for a genuinely new synthesis, but never resume a Claude session or let Claude
accumulate hidden context.
