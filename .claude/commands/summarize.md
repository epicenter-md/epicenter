---
description: Generate a summary of current work progress
---

# Summarize Current Work

Generate a conversational summary of the current work, following the progress-summary skill guidelines.

## Steps

### 1. Gather Context

Collect information about current work state:

```bash
# Branch and recent commits
git log --oneline -15

# Changes from main branch
git diff main...HEAD --stat
git log main..HEAD --oneline

# Current status
git status
```

If in a Conductor workspace, also use `GetWorkspaceDiff` to see the full diff.

### 2. Read Key Files

Read any files that were significantly modified to understand the substance of changes, not just diff stats.

### 3. Generate Summary

Follow the [progress-summary skill format](../../.agents/skills/progress-summary/SKILL.md):

- **Start with WHY**: What problem are we solving? What motivated this work?
- **Show the journey**: What approaches were tried? What decisions were made?
- **Use ASCII diagrams** for complex architecture (layers, flows, comparisons)
- **Be conversational**: Write like explaining to a colleague
- **Avoid**: File lists, corporate speak, marketing language, dramatic hyperbole

### 4. Match Scope to Request

- Quick check-in → 2-4 sentences
- Session recap → Problem, decisions, current state, what's left
- Architecture overview → Include ASCII diagrams showing evolution/layers/flow

## Arguments

If the user provides `$ARGUMENTS`, use it to scope the summary:

- "today" → Focus on today's changes
- "this PR" → Focus on PR-specific changes
- A file/component name → Focus on that specific area
