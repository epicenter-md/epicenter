---
name: radical-options
description: "Use when a task seems trapped inside the current abstraction, an abstraction feels poorly designed, a fix keeps spreading across layers, or the user asks to think bigger, redesign from scratch, mentally inline, go up a level, or consider radical options. Forces a higher-level pass before coding: state the current path, invent the cleanest from-scratch option, inline suspicious layers, find asymmetric deletions, and choose the option that makes the system easiest to explain."
---

# Radical Options

The local fix might be honoring a bad shape.

The move is simple: step out of the current abstraction before improving it.
Sometimes the correct answer is not a cleaner wrapper, a narrower helper, or one
more option. Sometimes the correct answer is to redesign the surface from the
product sentence down and delete the old constraint that made the code weird.

Related skills: use [greenfield-clean-breaks](../greenfield-clean-breaks/SKILL.md)
when the radical option changes public contracts, package boundaries, or
migration strategy. Use [one-sentence-test](../one-sentence-test/SKILL.md) to
name the system before auditing it. Use
[asymmetric-wins](../asymmetric-wins/SKILL.md) for the refuse-one-shape-to-
delete-a-code-family decision. Use
[first-read-review](../first-read-review/SKILL.md) when the problem is
mostly first-read clarity.

## The Ritual

Do this before coding when the skill triggers.

```txt
Current path:
  What are we about to do if we stay inside the existing shape?

Friction:
  What feels weird, indirect, duplicated, defensive, or hard to explain?

Radical option:
  What would the surface look like if designed today with no compatibility burden?

Deletion prize:
  What code family disappears if we take the radical option?

User loss:
  Who loses what behavior, migration smoothness, or convenience?

Decision:
  Take the radical option / keep the current shape
  because ...
```

Write this out when discussing a design or spec. For tiny code edits, it can be
a short internal pass, but still let the result steer the implementation.

## Start From The Ideal Call Site

Design the consumer experience first. Ignore the existing abstraction for a
moment.

```ts
const workspace = await openWorkspace({
	path,
	auth,
});
```

Then work backward:

```txt
What must be true for this call site to be honest?
Which layer should own each invariant?
Which existing abstractions become unnecessary?
Which old behavior is this refusing?
```

If the ideal call site needs callers to pass unrelated concepts, the boundary is
still wrong. If it hides policy the caller must understand, the abstraction is
too soft.

## Mental Inlining Pass

Mentally inline suspicious helpers, wrappers, options, adapters, and files into
their callers.

Ask:

```txt
What does this layer add after its name is removed?
Would the caller be clearer with this code inline?
Is this boundary protecting unsafe input or only hiding simple control flow?
Does the abstraction own an invariant, or does it merely pass data through?
Was this created by the old design rather than the current problem?
```

Keep the abstraction only when it earns one of these jobs:

- owns a real invariant
- isolates unsafe input or interop
- names non-obvious domain behavior
- makes multiple callers simpler in the same way
- gives a package or runtime boundary a stable contract

Otherwise, inline it or redesign above it.

## Go Up One Level

When the local fix keeps growing, ask what the code is compensating for.

```txt
Local symptom:
  We need another boolean to know whether teardown finished.

One level up:
  Why can callers observe a half-torn-down workspace?

Radical option:
  Make workspace teardown a single owning transition and remove all downstream
  "is it gone yet?" checks.
```

The goal is not a larger diff. The goal is a smaller explanation.

## Asymmetric Option Check

Look for one refusal that deletes a whole code family: an old shape, rare mode,
fallback, alias, fast path, or provider-specific behavior whose removal collapses
adapters, unions, flags, docs branches, tests, UI states, migration code, and
defensive checks.

This is the asymmetric wins move. [asymmetric-wins](../asymmetric-wins/SKILL.md)
owns the candidate list, procedure, and decision template. Default toward refusal
when the product sentence survives and the deletion prize is large; keep the
behavior when the user loss is load-bearing.

## Decision Rules

Choose the radical option when:

- the current abstraction is the main source of complexity
- the higher-level invariant is clear
- refusing the old shape leaves the product sentence intact
- the new system is easier to explain in one sentence
- migration cost is finite and can be done in one clean wave

Keep the current shape when:

- the abstraction owns a real boundary
- the weirdness comes from an external API, file format, or runtime constraint
- the radical option deletes behavior users actually rely on
- the extra migration cost is larger than the explanation win

## Output Shape

When reporting back, be direct:

```txt
Radical option:
  Replace the wrapper stack with one workspace lifecycle owner.

Why:
  The wrappers only preserve an old split between auth and workspace state.

What disappears:
  Two readiness flags, one adapter, one stale type alias, and three downstream
  defensive checks.

Decision:
  Take it. The product sentence still holds, and no user-facing behavior is
  lost.
```

Do not make radical options theatrical. The useful version is calm, specific,
and willing to delete clever code.
