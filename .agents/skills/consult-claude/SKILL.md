---
name: consult-claude
description: Give Claude one fresh, read-only, evidence-seeking independent judgment on a bounded question. Use when the user asks Codex to consult Claude or when an independent investigation would materially reduce risk in a high-stakes, ambiguous, architectural, product, planning, or clean-break decision. Do not use for implementation, an obvious bounded decision, or a continuing Claude conversation.
---

# Consult Claude

Invite Claude to investigate one question as an independent collaborator. Give
it the outcome you need, the few sources or facts worth seeing, and any real
boundary. Do not give it a theory to defend, a mandatory form to complete, or a
set of decisions to make later.

Write the invitation naturally and briefly. Ask Claude to follow its own
reasoning, replace the framing when the evidence warrants it, and return a
decisive memo with the direction it chose, why, and what follows. A current
hypothesis is optional evidence, never the assignment.

The consultation is read-only. The runner exposes `Read`, `Glob`, `Grep`,
`WebFetch`, and `WebSearch`, but neither shell nor edit tools. Keep it inside
the task's repository and subject; ask the user before including credentials,
personal data, unrelated private material, or a system that needs new access.

## Run it

Resolve this skill's directory from its loaded `SKILL.md` path. Start
`scripts/consult-claude.ts` in the task's working directory with a PTY. Write
the invitation to stdin, then send `Ctrl-D`. The runner uses high effort, safe
mode, and no session persistence, so include the repository instructions that
materially affect the question.

Keep the command attached. Treat silence as slow, not hung: it emits a
heartbeat every minute. Cancel when the user changes direction or the
consultation is no longer useful.

Afterward, verify material factual discoveries, preserve Claude's chosen
direction accurately, and carry in-scope consequences forward. Escalate only a
destructive action, external write, unrelated private-data access, or material
expansion beyond the user's request.
