---
name: specification-writing
description: Write technical specs that let agents implement autonomously. Use for "write a spec", "plan this feature", "create a planning doc".
metadata:
  author: epicenter
  version: '1.0'
---

# Specification Writing

Follow [writing-voice](../writing-voice/SKILL.md) for prose sections.
Follow [notebook-explanation](../notebook-explanation/SKILL.md) for mental models, ownership diagrams, flow diagrams, and compressed rules.

A specification gives an agent or maintainer the context they need to implement a feature autonomously. The goal is not to describe everything exhaustively. The goal is to make the current truth easy to find, show enough evidence that the direction is credible, and give the implementer a concrete launch point.

> **Note**: This guide uses `[PLACEHOLDER]` markers for content you must fill in. Code blocks show templates; replace all bracketed content with your feature's details.

## When to Apply This Skill

Use this pattern when you need to:

- Plan a feature with a spec that enables autonomous implementation.
- Document research findings, trade-offs, and design rationale.
- Define phased implementation tasks with trackable checkboxes.
- Capture open questions and recommendations without over-prescribing.
- Lay out architecture with tables/diagrams instead of wall-of-prose plans.

## References

Load these on demand based on the spec's decision surface:

- If writing a spec with **many trade-offs, migration cleanup, or "keep for consistency" decisions**, read [references/decision-hygiene.md](references/decision-hygiene.md).
- If writing a spec with **architecture, API, lifecycle, or ownership changes**, read [../pull-request/references/body-patterns.md](../pull-request/references/body-patterns.md) for before/after examples and visual communication rhythm.

## The Core Philosophy

Specs should:

- **Provide context, not instructions**: Give the "why" and "what", let the implementer figure out "how"
- **Document research, not conclusions**: Show what was explored, what exists, what doesn't
- **Leave questions open**: The Open Questions section is a feature, not a bug
- **Enable autonomous implementation**: An agent reading this should spawn sub-agents to verify and extend
- **Respect maintainer time**: Make the active path obvious before asking the reader to absorb history, appendices, or implementation logs

A good spec is a launching pad, not a script to follow.

**Before outlining sections, apply the [one-sentence-test](../one-sentence-test/SKILL.md).** If you can't name what this spec is about in one concrete sentence, the design is not coherent yet. That is the finding, and the spec is not ready.

---

## Maintainer-Time Contract

The first screen of a spec must answer:

```txt
What is this?
Is it active, implemented, superseded, or historical?
What is the current shape?
What is the target shape?
What proves the change is done?
```

Large specs are allowed. Thoroughness is useful when the work is deep. The rule is not "split after N lines." The rule is: do not make one reader job fight another.

Split or add a short active slice when a document mixes:

- North-star architecture and concrete execution steps.
- Historical debate and current implementation path.
- Spec content and handoff prompts.
- Appendices or ledgers that are useful, but not needed to start work.

When keeping everything in one file, add a "How to read this spec" block near the top:

```txt
Read first:
  One Sentence
  Current State
  Target Shape
  Implementation Plan
  Verification

Read if changing the architecture:
  Design Decisions
  Rejected Alternatives
  Edge Cases

Historical only:
  Implementation Notes
  Superseded Decisions
  Execution Prompts
```

The reader should be able to get the current truth in one minute, the model in five minutes, and the execution path in fifteen minutes.

---

## Decision Hygiene

Classify every material decision:

| Class | Resolved by | Rule |
| --- | --- | --- |
| 1 | Evidence | Verify with source, test, or version check. |
| 2 | Design coherence | Apply the spec thesis consistently. |
| 3 | Taste under constraints | Pick deliberately and write the constraint. |

Before any "keep" decision, ask: "Would I add this if it did not already exist?"

- If yes, record the use case.
- If no but removal is churn, record it as a Class 3 keep in the Decisions Log.
- If no and removal is cheap, drop it now.

Never let evidence questions hide behind design coherence. Verify before deleting old paths. For examples and failure modes, read [references/decision-hygiene.md](references/decision-hygiene.md).

---

## Adjacent Work

Most specs do not need a section for adjacent work. When adjacent work matters,
write only what the implementer needs:

```txt
Deferred:
  not required now, allowed later

Opportunistic:
  not required, but acceptable to fix if discovered and grounded
```

A spec is an execution spine, not a file whitelist.

---

## Document Structure

### Header (Required)

```markdown
# [Feature Name]

**Date**: [YYYY-MM-DD]
**Status**: Draft | In Progress | Implemented | Superseded | Retrospective
**Owner**: [Name/team responsible for decisions]
**Branch**: [optional: branch name if work has started]
**Supersedes**: [optional: previous spec paths]
**Superseded by**: [optional: later spec path]
```

### One Sentence

Every spec needs one concrete sentence before the overview. This is the maintainer's anchor.

```markdown
## One Sentence

[One sentence naming the new shape and the boundary it changes.]
```

### Overview

One paragraph max. Describe what the feature does. Don't sell it.

```markdown
## Overview

[One to two sentences describing what this feature adds or changes and what it enables. Be specific about the capability, not vague about benefits.]
```

### Motivation

Structure as **Current State**, **Problems**, then **Desired State**.

```markdown
## Motivation

### Current State

[Show actual code or configuration demonstrating how things work TODAY. Use real code blocks, not prose descriptions.]

This creates problems:

1. **[Problem Title]**: [Specific explanation of what breaks or is painful]
2. **[Problem Title]**: [Specific explanation of what breaks or is painful]

### Desired State

[Brief description of what the target looks like. Can include a code snippet showing the ideal API or structure.]
```

### Research Findings

This is where specs shine. Document what you FOUND, not what you assumed.

```markdown
## Research Findings

### [Topic Researched]

[Description of what you investigated and methodology]

| [Category]    | [Dimension 1]  | [Dimension 2]    |
| ------------- | -------------- | ---------------- |
| [Project/Lib] | [What they do] | [Their approach] |
| [Project/Lib] | [What they do] | [Their approach] |

**Key finding**: [Your main discovery, for example that no standard exists, or that everyone does X]

**Implication**: [What this means for your design decisions]
```

Include:

- What similar projects do (comparison tables)
- What you searched for but didn't find ("No Established Pattern Exists")
- Links or references to documentation you consulted

### Design Decisions

Use a table for traceability. Every material decision should have a class and rationale.

```markdown
## Design Decisions

| Decision            | Class       | Choice           | Rationale                       |
| ------------------- | ----------- | ---------------- | ------------------------------- |
| [Decision point]    | 1 evidence  | [What you chose] | [Source, test, or version checked] |
| [Decision point]    | 2 coherence | [What you chose] | [How this follows the thesis]   |
| [Decision point]    | 3 taste     | [What you chose] | [Constraint and trade-off]      |
| [Deferred decision] | Deferred    | Deferred         | [Why it is deferred and what would bring it back] |
```

### Architecture

Diagrams over prose. Prefer fenced text diagrams, file trees, route tables, and before/after blocks. Use simple ASCII diagrams by default because they are fast to write and easy to edit. Use box-drawing characters only when a polished diagram is worth the extra weight.

```markdown
## Architecture

[Describe what the diagram shows]
```

```txt
[caller]
  -> [boundary or route]
    -> [policy or validation]
      -> [storage or primitive]
```

For multi-step flows:

```txt
Step 1: [Step name]
  [What happens in this step]

Step 2: [Step name]
  [What happens in this step]
```

### Catalogs (when introducing a primitive set)

When the spec introduces a coherent set of new primitives (column types, action variants, error kinds, modifier methods, etc.), present them as a **catalog**: a compact code block that lists every primitive with a one-line annotation, followed by detail sections only for the ones that need elaboration.

Catalogs let a reader scan the entire surface in one glance before diving into any single primitive.

````markdown
## The column.* catalog

```ts
column.string<TBrand?>(s?)              // TEXT (TBrand for branded strings)
column.number(s?)                       // REAL
column.integer(s?)                      // INTEGER
column.boolean()                        // INTEGER 0/1
column.literal(value)                   // TEXT (single literal)
column.enum([...])                      // TEXT + CHECK constraint
column.json<S extends TSchema>(schema)  // TEXT JSON-encoded, schema required
column.nullable(inner)                  // Type.Union([inner, Type.Null()])
column.dateTime(s?)                     // RFC 3339 string, branded DateTimeString
column.ianaTimeZone(s?)                 // IANA zone string, branded IanaTimeZone
```

Every primitive justified by N+ existing call sites in the audit.

### What was considered and rejected

| Candidate | Why rejected |
|---|---|
| `column.id()` | Subsumed by `column.string<IdBrand>()` + a co-located `generate*` factory |
| `column.array(of)` | Subsumed by `column.json(Type.Array(of))` |
| Declaring `_v` as a column | Library-managed; positional in `defineTable(v1, v2, ...)` |
````

A "rejected candidates" table is often as useful as the catalog itself: it shows the implementer what *not* to add, and why. The reader gains confidence that the surface is tight.

### Call Sites (before/after on real code)

When the spec changes a consumer-facing API, show **at least 2-3 real call sites translated**, not invented examples. Real code surfaces semantic shifts the abstract proposal misses.

Find actual usages in the codebase first. Show the verbatim "Before" with file:line, then the "After" translation. Annotate any non-obvious mapping with a brief comment.

````markdown
## Call sites: before and after

### honeycrisp notes table

**Before** (`apps/honeycrisp/src/lib/workspace.ts:78`):

```ts
const notesTable = defineTable(
  type({ id: NoteId, title: 'string', _v: '1' }),
  type({ id: NoteId, title: 'string', wordCount: 'number | undefined', _v: '2' }),
).migrate(...)
```

**After**:

```ts
const notesTable = defineTable(
  { id: column.string<NoteId>(), title: column.string() },
  {
    id: column.string<NoteId>(),
    title: column.string(),
    wordCount: column.nullable(column.number()),
  },
).migrate(({ value, version }) => {
  switch (version) {
    case 1: return { ...value, wordCount: null };
    case 2: return value;
  }
});
```

**Semantic shift to flag**: rows previously stored with `wordCount` key absent will now read as `null` instead of `undefined`. Affects app code doing `if (row.wordCount === undefined)`. Also: `_v` no longer appears in the column record; it is library-managed and stripped from returned rows.
````

The "semantic shift to flag" callouts are critical: they're what the implementer needs to grep for and codemod across the codebase.

### Implementation Plan

Break into phases. Use checkboxes for tracking. Phase 1 should be detailed; later phases can be rougher (the implementer will flesh them out).

```markdown
## Implementation Plan

### Phase 1: [Phase Name]

- [ ] **1.1** [Specific, atomic task]
- [ ] **1.2** [Specific, atomic task]
- [ ] **1.3** [Specific, atomic task]

### Phase 2: [Phase Name]

- [ ] **2.1** [Higher-level task the implementer will break down]
- [ ] **2.2** [Higher-level task]
```

#### Wave ordering for clean breaks: Build, Prove, Remove

If the spec replaces an old code path with a new one, write separate phases:

```txt
1. Build the new path                     (waves 1 to N)
2. Stop importing the old path             (one wave; old code stays on disk, unused)
3. Verify (typecheck, tests, smoke)        (one wave; rollback is one revert)
4. Delete the old path                     (final cleanup wave)
```

Do not schedule deletion before verification passes. [cohesive-clean-breaks](../cohesive-clean-breaks/SKILL.md) owns the full Build, Prove, Remove rationale.

### Edge Cases

List scenarios that might break assumptions or need special handling.

```markdown
## Edge Cases

### [Scenario Name]

1. [Initial condition]
2. [What happens]
3. [Expected outcome or "See Open Questions"]

### [Scenario Name]

1. [Initial condition]
2. [What happens]
3. [Expected outcome]
```

### Open Questions

This section signals "you decide this" to the implementer. Include your recommendation but don't close the question.

```markdown
## Open Questions

1. **[Question about an unresolved design decision]**
   - Options: (a) [Option A], (b) [Option B], (c) [Option C]
   - **Recommendation**: [Your suggestion and why, but explicitly leave it open]

2. **[Another unresolved question]**
   - [Context about why this is uncertain]
   - **Recommendation**: [Suggestion or "Defer until X"]
```

### Adjacent Work

```markdown
## Adjacent Work

- [Decision or feature]: [Why it is not required now, and what would bring it back.]
- [Issue or cleanup]: [Why it is not required, but may be fixed if discovered and grounded.]
```

### Decisions Log

Use this section only for Class 3 keeps. Each entry must name the constraint and a revisit trigger.

```markdown
## Decisions Log

- Keep `[name]`: [constraint or trade-off].
  Revisit when: [specific signal that would make the keep decision worth re-opening].
```

### Success Criteria

How do we know this is done? Checkboxes for verification.

```markdown
## Success Criteria

- [ ] [Specific, verifiable outcome]
- [ ] [Specific, verifiable outcome]
- [ ] [Tests pass / build succeeds / docs updated]
```

### References

Files that will be touched or consulted.

```markdown
## References

- `[path/to/file.ts]` - [Why this file is relevant]
- `[path/to/pattern.ts]` - [Pattern to follow or reference]
```

---

## Good vs Bad Specs

### Good Spec Characteristics

- **Research is documented**: Shows what was explored, not just conclusions
- **Decisions have rationale**: Every choice has a "why" in a table
- **Questions are left open**: Implementer has room to decide
- **Code shows current state**: Not described abstractly
- **Architecture is visual**: ASCII diagrams over prose
- **Phases are actionable**: Checkboxes that can be tracked
- **First screen is useful**: Status, one sentence, current shape, target shape, and proof are easy to find
- **History is labeled**: Superseded decisions and implementation notes do not masquerade as active instructions

### Bad Spec Characteristics

- **Prescriptive step-by-step**: Reads like a tutorial, no room for autonomy
- **Assumes without research**: "We'll use X" without exploring alternatives
- **Closes all questions**: No Open Questions section
- **Abstract descriptions**: "The system will handle Y" without showing code
- **Wall of prose**: No tables, no diagrams, no structure
- **Reader-job mixing**: North-star architecture, execution prompt, handoff notes, and historical debate are all interleaved without a read path
- **Process theater**: Sections exist because the template said so, not because they change implementation or review

---

## Writing for Agent Implementers

When an agent reads your spec, they should:

1. **Understand the problem** from Motivation section
2. **Know what's been explored** from Research Findings
3. **See the proposed direction** from Design Decisions
4. **Have a starting point** from Implementation Plan Phase 1
5. **Know what to investigate further** from Open Questions

The agent will then:

- Spawn sub-agents to verify your research
- Explore the Open Questions you left
- Flesh out later phases of the implementation plan
- Make decisions where you left room

If your spec is too prescriptive, the agent will blindly follow it. If it's too vague, the agent will flounder. The sweet spot is: **enough context to start, enough openness to own the implementation**.

---

## Quick Reference Checklist

```markdown
- [ ] Header (Date, Status, Owner)
- [ ] One Sentence
- [ ] First screen answers active status, current shape, target shape, and proof
- [ ] "How to read this spec" block when the file is long or partly historical
- [ ] Overview (1-2 sentences)
- [ ] Motivation
  - [ ] Current State (with code)
  - [ ] Problems (numbered)
  - [ ] Desired State
- [ ] Research Findings
  - [ ] Comparison tables
  - [ ] Key findings
  - [ ] Implications
- [ ] Design Decisions (table with rationale)
- [ ] Design decisions have classes
- [ ] Class 1 decisions were verified
- [ ] Class 3 keeps are logged with `Revisit when:`
- [ ] Adjacent work is included only when it clarifies implementation
- [ ] Catalogs (when introducing a primitive set: code block + rejected candidates table)
- [ ] Architecture (ASCII diagrams)
- [ ] Visual rhythm: prose is broken up with code, tables, trees, or diagrams where relationships matter
- [ ] Call Sites (before/after on 2-3 real usages with file:line)
- [ ] Implementation Plan (phased checkboxes)
- [ ] Edge Cases
- [ ] Open Questions (with recommendations)
- [ ] Success Criteria
- [ ] References
```

Not every spec needs every section. A small feature might skip Research Findings. A migration spec might focus heavily on Edge Cases. Use judgment.
