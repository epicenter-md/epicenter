---
name: consult-claude
description: Run Claude Code as an independent reviewer or research laboratory while you keep ownership of the live repository. Use when the user asks to consult Claude, requests a Claude review, or asks Claude to investigate or research independently.
---

# Consult Claude

The consulted Claude owns a sealed laboratory. You own the living checkout,
integration, and final decision. A consultation is not a packet-only print
call: Claude gets an editable snapshot of the current repository and may
research, rewrite code, run tests, commit experiments, and change its mind
there. The living checkout is not part of Claude's tool boundary.

Give Claude one outcome, the settled values it must preserve, and source
territory worth starting from. Do not give it your working theory, a menu of
answers, or a prescribed method. Tell it what would make the research complete.
The runner supplies the snapshot ID, laboratory boundary, checkpoint path, and
permission profile.

Start the native Claude background session from the repository root and keep
the command attached when the user wants the answer before this task continues:

```bash
bun .agents/skills/consult-claude/scripts/consult-claude.ts start --wait
```

Type the compact research brief, then send EOF. `start` prints a run ID, native
Agent View ID, native session ID, and checkpoint path. It creates an independent
replica, removes its Git remote, and keeps Bash network egress offline. Claude
may search the web, but direct fetching or any external action is a deliberate
escalation, not part of the default run. It does not recreate Claude's session
manager: inspect, attach, steer, or stop the live worker with `claude agents`.

Read the latest result without waking the worker:

```bash
bun .agents/skills/consult-claude/scripts/consult-claude.ts status <run-id>
```

When Claude writes `state: needs-decision` or `state: complete`, you may
continue the same laboratory conversation. The runner archives the prior
checkpoint and waits for a fresh one when requested:

```bash
bun .agents/skills/consult-claude/scripts/consult-claude.ts follow-up <run-id> --wait
```

Type the follow-up, then send EOF. Do not use this to interrupt a working
laboratory; reply through `claude agents` when immediate steering is needed.
Every checkpoint is tied to one snapshot. Treat a claim that cannot be
re-verified against the living checkout as a question, not a fact. When live
work has materially moved on, start a new laboratory snapshot; never silently
refresh a worker's replica beneath it.

Use each checkpoint to decide whether to edit, ask Claude a sharper question,
or stop. Consultation does not transfer authorship: Claude-generated patches
are evidence, not changes to apply. Return Claude's recommendation,
material objections, and any remaining disagreement to the user.
