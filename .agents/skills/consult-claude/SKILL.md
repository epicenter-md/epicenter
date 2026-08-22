---
name: consult-claude
description: Use when the user asks to consult Claude or asks Claude to review, investigate, or challenge a decision or implementation slice. Not for handoffs or having Claude implement.
---

# Consult Claude

The active agent owns conversation continuity, repository changes, testing,
integration, and the final decision. Claude is an advisory review lane, not a
second execution path. It gives strong recommendations, tests the framing, and
pushes back when the proposed work is shallow or headed in the wrong direction.

Prepare a compact context packet before consulting. Include the outcome being
pursued, the current model, settled user preferences, relevant repository
evidence, the unresolved question, and any dirty-worktree or safety boundary
the review must respect. Include file contents, diffs, and test output when
Claude needs them; do not make Claude rediscover context that the active agent
already has.

There are two useful consultation waves. A direction wave asks Claude to
inspect the model, surface the real tradeoffs, and make one strong
recommendation. A review wave includes the implementation plan or meaningful
diff plus verification evidence and asks Claude to challenge the result, find
hidden coupling or incomplete behavior, and say what should change. Use either
wave or both according to the user's request. A review is not complete because
Claude approved the work; it is complete when the agent can explain why the
important pushback was resolved or rejected.

Run the consultation as a non-persistent, no-tools Claude Code print session.
The prompt must contain the evidence Claude is expected to use, and the
session must not edit files, create a worktree, commit, resume, or publish:

```bash
claude -p "$prompt" --no-session-persistence --tools "" --effort high
```

If the output identifies a missing fact, gather that fact in the active agent
and run another wave. Do not turn a request for consultation into a durable
Claude implementation session. Do not create an isolated worktree for a
consult. If the user wants Claude to own repository changes or continue
independently, that is a separate capability that is not part of this skill;
use a manual handoff only when the user explicitly asks for one.

Consultation does not transfer authority. The active agent chooses whether to
implement, which agent should implement, and when another review wave is worth
the context cost. Consult at high-leverage boundaries: before locking a design,
after a meaningful implementation slice, or when new evidence changes the
model. Do not spend a Claude wave on a plain question or every trivial edit.

Return Claude's recommendation and material objections to the user in the
active conversation, preserving disagreement when it remains unresolved.
