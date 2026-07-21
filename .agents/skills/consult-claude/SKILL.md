---
name: consult-claude
description: Give Claude one fresh, read-only, evidence-seeking adversarial memo on Codex's grounded synthesis. Use when the user asks Codex to consult Claude or when an independent investigation would materially reduce risk in a high-stakes, ambiguous, architectural, product, planning, or clean-break decision; Codex may invoke it autonomously after forming an evidence-backed read. Do not use for implementation, an obvious bounded decision, or a continuing Claude conversation.
---

# Consult Claude

Consult Claude gives one fresh reasoning trajectory enough read access to
investigate and attack Codex's grounded synthesis. The user owns product
direction. Codex owns the user dialectic, consultation boundary,
reconciliation, and final recommendation. Claude owns the independent
investigation and one evidence-backed adversarial memo. The runner enforces
read-only authority and a bounded lifetime.

Codex may escalate autonomously when getting the judgment wrong would cost
substantially more than the additional latency and quota. Announce the
consultation and why it earns the escalation before starting it. Do not consult
to avoid forming a grounded position first.

## Ground the challenge

Read enough evidence to state a positive synthesis before consulting. Give
Claude the sources and directional data that explain that synthesis, but do not
close the record around Codex's evidence selection. Preserve verbatim user
reactions when summarizing them would flatten the user's taste.

Start every packet with this mandate:

```txt
Mandate:
  Attack the synthesis as a whole. Surface inherited assumptions and hidden
  compromises, articulate the strongest rival, test the important failure
  modes, and recommend the best direction. Propose collapse or a clean break
  when the evidence earns it, not as a default.

  Treat the supplied evidence as a grounded starting point, not a closed
  record. Inspect relevant repository sources and authoritative documentation
  when doing so could verify, falsify, or materially improve the synthesis.
  Report consequential discoveries with precise source locations and
  distinguish discovered evidence from your interpretation.

  Return one decisive memo. Do not edit files, run mutating operations, ask the
  user questions, implement, or continue the task.
```

Then make the packet cold-start complete:

```txt
Mission:
  The bounded subject or design problem.

Evolution:
  How the vision changed during the Codex-user dialectic.

Directional data:
  Selected user reactions, rejected framings, and recognition criteria.

Starting evidence:
  Established excerpts, diffs, command output, paths, and durable decisions.
  Include decisive context directly and name sources Claude should inspect.

Current synthesis:
  Codex's positive model and reasoning.

Strongest rival:
  The best competing vision or objection Codex can already articulate.

Investigation questions:
  Facts, assumptions, and architectural boundaries that remain open to attack.

Constraints:
  Product promises, ownership boundaries, security limits, and refusals.

Deliverable:
  The memo shape that will help Codex reconcile the challenge.

Stop:
  Answer this bounded problem. Do not implement or expand the task.
```

Give Claude relevance-complete direction, not a conclusion-only summary or a
repository dump. Point it at the strongest starting sources so investigation
can follow consequential leads instead of repeating Codex's entire discovery
pass.

## Run one read-only investigation

Prerequisites: Bun and a current, authenticated Claude CLI on macOS or Linux.
Resolve this skill's directory from its loaded `SKILL.md` path. Start
`scripts/consult-claude.ts` in the task's working directory with a PTY and keep
the returned command session attached. The runner switches terminal input to
raw, non-echoing mode. Write the complete packet to stdin, then send the EOT
character (`Ctrl-D`). The runner accepts no prompt arguments and creates no
files.

The runner starts a high-effort Claude turn in safe mode with an explicit tool
allowlist and plan permission mode. Claude may read and search files, use
read-only shell commands, and consult public web sources. It cannot edit files
or persist the session. Safe mode prevents project instructions, skills,
plugins, hooks, MCP servers, and other hidden configuration from shaping the
independent trajectory, so the packet must name the repository instructions
and sources that matter.

Read-only protects repository integrity, not confidentiality. Sending the
packet and running tools exports their relevant contents to the locally
authenticated Claude provider. Keep investigation inside the task's repository
and subject. Do not direct Claude into credentials, environment files, personal
data, unrelated private material, or broader external systems. Ask the user
before crossing that boundary. If the runtime blocks required in-scope access,
do not silently weaken the investigation; explain the boundary.

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
2. Separate starting evidence, newly discovered evidence, and Claude's opinion.
3. Verify every material discovery against local files or authoritative
   sources.
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
