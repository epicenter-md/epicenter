# Instruction Placement

Use this reference when deciding where repository guidance belongs. The goal is
not to capture every lesson. The goal is to keep future agents pointed at the
smallest durable instruction that changes behavior.

## Product Sentence

Write this sentence first:

```txt
AGENTS.md routes always-on repo constraints; skills own triggerable workflows; references hold conditional detail; CLAUDE.md shims import AGENTS.md.
```

If the proposed instruction does not fit that sentence, change the placement
before changing the prose.

## Placement Rules

```txt
AGENTS.md      rules every agent must carry before any skill is selected
SKILL.md       repeatable workflow selected by a concrete user intent
references/   long examples or conditional detail loaded only when needed
scripts/      deterministic fragile work better done by code
CLAUDE.md      compatibility shim, usually only @AGENTS.md
delete         one-off advice, taste notes, or rules already owned elsewhere
```

Do not create a new skill when an existing skill already owns the same user
intent. Update the existing skill, narrow its description, or move detail into a
reference instead.

## Always-On Rules Route

An `AGENTS.md` rule that names a skill is a routing rule, and it is measurably
the only thing that routes a broad intent no description claims. Where a
description already owns the phrase, the description wins and the rule changes
nothing about that route.

That asymmetry says which rule earns its place. It does not license a cleanup
pass over the ones that do not: shortening the paragraph cost orphan routes it
still named, so gate influence is not the sum of its clauses. Treat every edit
to an always-on file as a routing change and measure it.
`references/evaluation.md` carries the method and the evidence;
`audit-routing-collisions.ts` reports where a rule and a description claim the
same phrase.

## Greenfield Questions

Ask these questions in order:

```txt
What repeated failure does this prevent?
Which future prompt should trigger this instruction?
Which near-miss prompt should not trigger it?
Who has to carry this text on every task?
Which existing instruction already owns the behavior?
What can be deleted, moved to references, or shortened?
Does the new shape reduce loaded context or only add another place to check?
```

Default to deletion when the answer is "this was useful once." Update an
existing skill when the answer is "same trigger, sharper behavior." Add a skill
only for a separate trigger, repeatable workflow, and lower total routing cost.

## Output Shape

Before editing, report:

```txt
Instruction sentence:
  ...

Current surface:
  AGENTS.md / existing skill / reference / absent

Drift:
  duplicated rule / wrong owner / too much detail / missing trigger / one-off note

Decision:
  keep global / update skill / add skill / move to reference / delete

Why this reduces complexity:
  ...
```
