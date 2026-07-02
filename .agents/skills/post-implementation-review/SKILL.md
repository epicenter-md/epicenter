---
name: post-implementation-review
description: "Hub for the broad second-read pass after an implementation: list every touched file as an ASCII tree, mentally inline helpers, audit dead paths and stale imports, name invariant owners, sanity-check API shape and naming. Delegates to focused skills (collapse-pass, cohesive-clean-breaks, greenfield-clean-breaks, refactoring, code-audit, one-sentence-test, approachability-audit, testing, typescript, svelte, yjs). Use after finishing an implementation, before handoff, or when the user says 'review what you just did', 'second pass', 'final sweep'."
metadata:
  author: epicenter
  version: '1.0'
---

# Post Implementation Review

Use this skill after code changes and before final handoff. The goal is a hard
second read: catch stale abstractions, dead paths, bad ownership, and confusing
names while the edit context is still fresh.

Do not silently fix structural concerns. First name what is wrong and why it
matters, then fix it when it clears the evidence bar below.

## Lane, Evidence, Limits

The user's request sets the lane. Evidence can widen the lane. Explicit user
limits close it.

```txt
Fix now:
  grounded correctness, invariant, public API, verification,
  and serious clarity issues on the touched path

Report:
  speculative cleanup, cosmetic cleanup, taste-only cleanup,
  and issues with weak evidence

Pause:
  explicit user limits, product direction, destructive actions,
  broad reshaping, or unclear ownership
```

Two things never move when the lane widens:

- The lane never widens silently. Every expanded edit is still flagged first,
  and stays easy to review, with a separate commit when commits are being made.
- The evidence bar never drops. "Within reason" still means grounded in
  caller counts, a real invariant, or a named smell, never a hunch. A user
  signal widens what you may touch; it does not lower the bar for why.

Authorship is not the gate. A smell the review uncovered can belong in the lane
when it is clear, important, and grounded, even if an earlier commit introduced
it. Explicit user limits still win.

## Related Skills

This skill is a hub for broad second reads. Focused requests can start from a
focused skill first, then escalate here when the work needs a full final pass.

Load only the skills that match the touched surface:

```txt
collapse-pass            continuous deletion of unearned indirection
cohesive-clean-breaks    public API, package boundary, config, lifecycle, naming, or ownership change
greenfield-clean-breaks  compatibility refusal and ideal-shape review
asymmetric-wins          refuse a feature to collapse a disproportionate code family
refactoring              caller counts, inlining, dead exports, stale imports, straggler sweep
approachability-audit    too many hops, misleading names, clever types, first-read confusion
code-audit               recurring repo smells and grep-based checks
one-sentence-test        new abstraction, wrapper, option, endpoint, command, or module
testing                  test files or changed behavior that needs coverage
typescript               type organization, inference, runtime schema, type tests
svelte                   Svelte components, stores, runes, query usage, UI state
yjs                      CRDT documents, shared types, transactions, conflict behavior
```

## Review Order

1. Identify every file touched by the implementation.
2. Re-read each touched file from top to bottom.
3. List every file read as an ASCII tree before analysis.
4. Run the mental inlining pass.
5. Run the ownership and collapse check.
6. Run the smell and invariant checks.
7. Review API shape, naming, and file organization.
8. Run diagnostics and tests appropriate to the changed lane. Reproduce any
   failure on clean HEAD before blaming the change; separate pre-existing red
   from regressions you introduced.
9. Report findings before making cleanup edits unless the issue is a direct
   compile or test failure.

The ASCII tree is not decoration. It forces the review to show its evidence.

```txt
Files read
packages/foo/
|-- src/
|   |-- create-foo.ts
|   |-- foo-options.ts
|   `-- index.ts
`-- package.json
```

## Mental Inlining Pass

Mentally inline every helper, wrapper, component, prop bundle, adapter, file,
factory, compartment, and extracted function back into its call sites, then keep
a layer only when it earns its place.

For the full ask-block and the keep-vs-inline criteria, use
[radical-options](../radical-options/SKILL.md) "Mental Inlining Pass". The
ownership check below applies the same test to runtime, durable, and
user-visible state.

## Ownership And Collapse Check

Before accepting the final shape, replay the change as if designing it from
scratch:

```txt
What object owns the runtime lifetime?
What object owns the durable state?
What object owns the user-visible state?
Which props exist only because of a stale file split?
Which calls need `untrack`, and would moving ownership remove that need?
```

Count callers for every new or changed helper, component, factory, wrapper, and
export. A one-caller boundary is guilty until it proves it earns its place;
judge it with the radical-options keep list cited above and the
[refactoring](../refactoring/SKILL.md) caller-count table, not a from-memory
paraphrase of either.

If a boundary only passes a stable handle, callback, or raw library object to
another one-call wrapper, collapse it. In particular, treat `untrack` inside an
imperative widget setup as a design prompt: sometimes it is the right tool for a
stable callback, but it can also reveal that the prop should not be reactive or
should not cross the component boundary at all.

## Smell Check

Look for:

```txt
dead exports, dead methods, dead config hooks
stale imports and stale JSDoc
redundant work after ownership moved earlier
identity wrappers and pass-through modules
unnecessary casts or duck-typing inside typed code
fallback parsers for old shapes
callbacks that mirror internal implementation steps
decision callbacks that could be caller-owned composition
single-file directories and pointless barrels
near-identical sibling files or types (judge: cheap independence or latent coupling)
```

If a smell is repo-recurring, use `code-audit` for the relevant grep pattern. If
the smell came from the refactor itself, use `refactoring` for the straggler
sweep.

## Invariant Audit

Name the layer that owns each important rule.

```txt
Invariant                         Owner
config shape is valid              config loader
route names are unique             defineConfig validation
document id is parsed once          document cache
runtime socket opens once           daemon startup
cleanup policy is app-owned         injected lifecycle callback
```

If an invariant is checked repeatedly downstream, move it earlier: construction,
validation, or the type signature. If a later layer no longer needs a safety
check because setup guarantees it, delete the redundant check and name the setup
guarantee in the review.

## API Shape

Read the public surface as if designing it today.

Ask:

```txt
Is there one obvious call site?
Do option names describe domain policy instead of implementation steps?
Did the change leave both old and new shapes alive?
Can TypeScript prevent the common misuse?
Does the lifecycle name match when side effects happen?
```

For clean breaks, compatibility is a feature only when explicitly requested.
Otherwise, delete old public names and update all examples to the new shape.

## Naming And Files

Names should match what the code does now, not what it used to do.

Check:

```txt
Does foo-manager.ts still manage anything?
Does create* construct, define* return inert definitions, start* begin runtime work?
Does a type name describe a real contract or a library workaround?
Does each file have one reason to exist for a new reader?
```

When file organization is part of the finding, show both trees before editing.

```txt
Current
packages/foo/src/
|-- lifecycle.ts
|-- lifecycle-options.ts
|-- cleanup.ts
`-- index.ts

Proposed
packages/foo/src/
|-- lifecycle.ts
`-- index.ts
```

## Output Shape

For a review-only pass, report:

```txt
Files read
[ASCII tree]

Findings
1. [severity] [file:line] What is wrong and why.

Would change
[Specific edits worth making]

Would leave alone
[Indirection or duplication that earns its keep]

Verification
[Commands run and result, or why not run. For any failure, note whether it
 reproduces on clean HEAD so pre-existing red is not misread as a regression.]
```

For an implementation pass, make the cleanup edits after reporting the issue in
the working notes. Keep the final answer short: what changed, what was left
alone, and what verified it.
