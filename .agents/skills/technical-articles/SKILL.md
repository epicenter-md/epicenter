---
name: technical-articles
description: Writing technical articles and blog posts. Use when creating articles in docs/articles/ or blog content explaining patterns, techniques, or lessons learned.
---

# Technical Articles

All articles must follow [writing-voice](../writing-voice/SKILL.md) rules.

## Core Principles

Title should BE the takeaway, not a topic. "Write Context to a File, Not a Prompt" not "Context Management in Agent Workflows".

Lead with a TL;DR (one sentence, bold the key insight) and a blockquote with the core principle. Reader should get it in 5 seconds.

Code speaks louder than prose. Show real examples from actual codebases, not abstract `foo`/`bar` illustrations. If the code is self-explanatory, don't over-explain.

ASCII diagrams for architecture or flow:

```
Conversation          Spec File           Subagent
    │                    │                   │
    │  write context     │                   │
    │───────────────────>│                   │
    │                    │                   │
    │                    │   read file       │
    │                    │<──────────────────│
    │                    │                   │
    │                    │   fresh context   │
    │                    │──────────────────>│
```

Tables for comparisons (skim-friendly, respect reader time):

| Instead of                | Do this            |
| ------------------------- | ------------------ |
| Copy-pasting context      | Write to spec file |
| Re-explaining each prompt | Pass the filename  |

## Constraints

Bullet lists and numbered lists: max 1-2 of each per article. If you need more, convert to prose or a table.

Section headings: use sparingly. Not every paragraph needs a heading. Let content flow.

Bold text: reserve for TL;DR only. Never bold in body content.

No space-dash-space: use colons, semicolons, or em dashes per writing-voice.

No rigid template: structure should fit the content, not the other way around. Some articles need a "Problem/Solution" flow; others just show code and explain. Don't force sections.

## What Makes Articles Good

- Real code from real codebases, not abstract examples
- ASCII diagrams that clarify architecture or data flow
- One table that summarizes the key comparison
- Tight prose that explains WHY, not WHAT (code shows WHAT)
- 30-80 lines for most articles; longer only if content demands it

## What Makes Articles Bad

- Rigid section structure that doesn't fit the content
- Multiple bullet lists and numbered lists throughout
- Abstract `foo`/`bar` code examples
- Over-explaining self-explanatory code
- Bold formatting scattered through body text
- Marketing language or AI giveaways

## Narrative Mode (Rare)

Most "journey to an insight" articles still work better as punchy. Use narrative only when the discovery process itself is the insight and can't be compressed.

When narrative fits: specific details ("750 lines", not "a large file"), direct statements over manufactured drama, build to an insight rather than starting with it.
