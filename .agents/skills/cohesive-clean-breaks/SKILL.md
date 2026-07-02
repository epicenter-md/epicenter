---
name: cohesive-clean-breaks
description: "Breaking-change and clean-break mechanics for decisions that change public shape, package boundaries, runtime contracts, naming, config structure, lifecycle ownership, or migration strategy: wave ordering, hybrid-API rejection, boundary movement, ownership tests, and deleting old paths instead of aliasing them. Use when proposing a breaking change, replacing an API, redesigning ownership, planning a multi-wave replacement, or deciding whether to keep both old and new paths alive. For the refuse-a-feature-to-collapse-complexity move on its own, use asymmetric-wins."
---

# Cohesive Clean Breaks

Use this skill when a coding decision changes public shape, package boundaries,
runtime contracts, naming, config structure, lifecycle ownership, or migration
strategy.

The goal is not to minimize diff size. The goal is to make the final system
easy to explain, hard to misuse, and free of half-old, half-new behavior.

Related skills: use [one-sentence-test](../one-sentence-test/SKILL.md) to state
the thesis, [asymmetric-wins](../asymmetric-wins/SKILL.md) for the refuse-a-
feature-to-collapse-a-code-family decision, [refactoring](../refactoring/SKILL.md)
for caller counting, the mental inlining pass, and straggler sweeps,
[approachability-audit](../approachability-audit/SKILL.md) for first-read clarity,
[change-proposal](../change-proposal/SKILL.md) when showing current and proposed
trees before editing, and
[post-implementation-review](../post-implementation-review/SKILL.md) after
implementation.

## References

Load these on demand based on the clean-break surface:

- If planning a **multi-wave replacement, rollback point, or old-path deletion**, read [references/wave-ordering.md](references/wave-ordering.md).

## One Sentence First

Start by writing the one sentence the new system must make true.

Good:

```txt
Config composes route definitions; app packages own their default route names.
```

Bad:

```txt
Support the new route format while preserving the old map for convenience.
```

If the sentence needs exceptions, aliases, or compatibility clauses to sound
true, the design is probably not clean yet.

## Ownership Test

For every important value and invariant, name the owner.

```txt
route name        app daemon package
route composition project config
socket ownership  daemon startup
runtime teardown  daemon runtime
peer lookup       peer directory
remote call       rpc attachment
```

If two layers own the same value, collapse the design before coding. Shared
ownership usually becomes drift.

If the same invariant is checked in several downstream files, move it to
construction time, validation, or the type signature. Repeated defensive checks
usually mean the boundary is too late.

## Deeper Violation Pass

Before patching a smell locally, ask what it is compensating for. Defensive
code is a receipt for a missing invariant one layer up. A microtask-window
pause, a try/catch that toasts and keeps running, a `Pick<Thing, 'method'>`
parameter, a "did we finish loading" boolean: each one is paying off something
the layer above does not enforce. Name the invariant before deleting the code.

Ask in this order:

```txt
What is this code compensating for?
Why is this violation a problem? Go up one more level.
What if we eliminate this behavior entirely?
Where could the boundary that owns this invariant move?
What would Better Auth, Yjs, Hono, or Rust do here?
```

Two heuristics for when this pass is required, not optional:

```txt
A small clean-up keeps growing as you implement it.
A "drop one option" needs a parameter threaded through five files.
```

That growth is the signal that the smell was not local. Stop, restate the
one-sentence description, and re-scope before continuing.

The corollary keeps the pass pragmatic: when the deep fix is the same size
as the surface fix, the surface fix is correct. The audit's value is not
bigger diffs. The audit's value is the difference between "the surface fix
would have left two of these alive" and "the deep fix collapses six surfaces
into one."

See `docs/articles/20260504T030000-when-the-smell-wont-die-go-up-a-level.md`
for the worked example (workspace identity reset, six surfaces collapsed
into one deterministic teardown).

## Asymmetric Wins Pass

Before installing a new invariant, run the asymmetric wins pass: can you refuse
10-20 percent of functionality to collapse 80-90 percent of the implementation
complexity? Find the small promise that owns a disproportionate code family,
then decide whether refusing it leaves the product sentence intact.

This move lives in [asymmetric-wins](../asymmetric-wins/SKILL.md): it owns the
candidate list, the procedure, the decision template, and the worked example.
Run it before adding any new invariant, then return here to execute the break.

## Scratch Redesign Pass

Before patching the current shape, ask what the API would look like if it were
designed today with no compatibility burden.

Write the ideal consumer call site first:

```ts
bindWorkspaceAuthLifecycle({
	auth,
	workspace,
	leavingUser: {
		afterCleanup: reload,
		onCleanupError: reportError,
	},
});
```

Then work backward into implementation. If the ideal call site needs the
consumer to pass unrelated things, the boundary is probably wrong. If it hides
important policy, the abstraction is too soft.

## Mental Inlining Pass

Before preserving a helper, layer, file, option, adapter, or component boundary,
run the [radical-options](../radical-options/SKILL.md) "Mental Inlining Pass":
inline it into its caller, then keep the layer only when it earns its place. The
per-change mechanics (caller counts, the inline-vs-keep decision table,
single-caller families) live in [refactoring](../refactoring/SKILL.md). Use both,
then decide ownership here.

## Dependency Injection and Inversion of Control

Prefer injected dependencies over hidden imports when behavior crosses package
or runtime boundaries.

Good:

```ts
attachLifecycle({
	reportError,
	reload,
});
```

Bad:

```ts
import { toast } from '@app/ui';
import { workspace } from '@app/singleton';
```

Use inversion of control when the lower layer knows when something happened,
but the upper layer owns the policy for what to do next. For example, a
workspace lifecycle helper may know that signed-out cleanup finished; the app
decides whether to reload, show a toast, navigate, or keep running.

Do not use dependency injection as a dumping ground. Inject stable policies,
clients, sinks, and factories. Do not inject a bag of callbacks that mirrors
every internal step of an implementation.

When callback hooks ask the caller to make decisions mid-flow, pause and test
the boundary. Hooks are not wrong by default, but decision callbacks often mean
one layer owns the decision and another layer owns the effect.

```txt
Smell:
  createRelay({
    resolveAccess,
    onAccessRecorded,
    onUsageChanged,
    onDisconnected,
  })

Question:
  Can the caller do this work before or after calling the lower primitive?

If yes:
  move the boundary down and let the caller compose the workflow

If no:
  the lower layer may own a real lifecycle point
```

Decision callbacks are especially suspicious when they mention access, billing,
audit, deletion, org membership, retry behavior, route errors, or what should
happen next. Prefer a smaller primitive that receives already-decided inputs and
returns mechanical facts the caller can record or act on. See
`docs/articles/move-the-boundary-down-one-layer.md` for the broader lesson.

Treat single-method `Pick<Thing, 'method'>` dependencies as a smell worth
checking. A single-method `Pick` often means the old object boundary leaked into
a place that only needed one verb. Prefer a named capability function in the
caller's language unless the caller genuinely participates in that object's
life cycle or needs the rest of the capability family. See
`docs/articles/single-method-pick-is-a-boundary-leak.md`.

Do not half-fix the smell by replacing `Pick<Thing, 'method'>` with
`Thing['method']`. If the caller's sentence does not name `Thing`, the
capability type should come from the caller's boundary or the runtime contract,
not from the source object that happens to implement it today.

## Boundary Movement

If a smell appears at several call sites, do not start by extracting a helper.
Ask which layer should own the invariant.

```txt
UI repeats cleanup            move cleanup to lifecycle binding
apps repeat sync registration move sync inventory to workspace
storage grows auth verbs      move auth shape to an adapter
core imports app concerns     move integration to the edge package
```

The best cleanup often moves a boundary instead of shortening a function.

## Go-to-Definition Awareness

A clean public shape is also a navigable one. A caller pressing Go-to-Def should
land on the actual source of truth, not on an alias, a re-export hop, or a
passthrough wrapper. If a design choice forces an extra navigation hop, name what
it earns (real validation, published contract, multi-impl port); otherwise
collapse the hop.

The smell catalog (re-export chains, destructure-re-exports, no-op adapters,
hand-written aliases over a factory's return shape) and the per-file mechanics
live in `typescript` "Go-to-Definition Awareness". Apply them when a clean break
changes how a type or value is exposed across a package boundary.

## Consumer Ergonomics Test

Read the final API as a new caller.

Ask:

```txt
What is the one obvious call site?
Which options are domain policies, not implementation steps?
Can TypeScript prevent the common mistake?
Does the name explain the lifecycle moment?
Can the caller ignore details it does not own?
```

Ergonomics does not mean hiding failure. A clean API makes required policy
obvious and optional policy genuinely optional.

## API Shape Pressure

Prefer APIs with one obvious shape and one obvious lifecycle moment.

Smells:

```txt
boolean flags that choose unrelated modes
options named after implementation steps
parallel old and new properties
callbacks for every internal phase
types that expose storage details to UI callers
```

Fix by moving policy to the caller, moving invariants to the callee, or
splitting two products into two APIs. Do not make one surface accept every
historical shape.

## Reject Hybrid APIs

Do not keep both old and new shapes unless migration support is the explicit
product goal.

Prefer:

```ts
export default defineConfig({
	daemon: {
		routes: [defineFujiDaemon()],
	},
});
```

Avoid:

```ts
export default defineConfig({
	daemon: {
		routes: {
			fuji: defineFujiDaemon(),
		},
		alsoRoutes: [defineFujiDaemon()],
	},
});
```

Hybrid APIs feel helpful during implementation, but they make every caller ask
which path is canonical. That is a code smell.

## Breaking Change Rules

When making a clean break:

1. Delete old public names instead of aliasing them.
2. Rename call sites in one sweep.
3. Update docs and examples to show only the new shape.
4. Validate at the new boundary, not at every downstream use.
5. Make failure messages name the new contract.
6. Leave no fallback parser for the old shape unless migration compatibility is
   the explicit product goal.
7. Move invariants to construction time or type signatures when possible.
8. Prefer lifecycle-shaped names over implementation-shaped names.
9. Refuse small convenience features when they force a second shape that will
   live forever.

Compatibility is a feature. If nobody explicitly asked for that feature, do not
smuggle it into the implementation.

## Wave Ordering: Build, Prove, Remove

When a clean break replaces an old code path with a new one, order the
implementation as four sequential phases:

```txt
Wave 1 to N    Build the new path
Wave N+1       Stop importing the old path (it stays on disk, unused)
Wave N+2       Verify (typecheck, tests, smoke against staging)
Wave N+3       Delete the old path
```

Verification is Class 1 evidence, not design coherence. Do not collapse "the
new design is coherent" into "the replacement works." Stop importing the old
path, verify, then delete. For the failure mode and worked example, read
[references/wave-ordering.md](references/wave-ordering.md).

## Naming Rules

Names should describe lifecycle and ownership.

```txt
define*     returns inert definitions
connect*    talks to an existing process or service
open*       creates or opens local resources
start*      performs side effects and begins runtime work
load*       reads and validates without starting resources
```

If a helper returns a delayed route definition, name it `defineFooDaemon()`, not
`fooDaemon()` or `openFooDaemon()`.

## Config Shape Rules

Default export should match the file name and the validated boundary.

```txt
epicenter.config.ts -> export default defineConfig(...)
```

Named exports are fine for local organization, but the default export is the
validated boundary.

```ts
export const fuji = defineFujiDaemon();

export default defineConfig({
	routes: [fuji],
});
```

Do not make the CLI scan arbitrary named exports. It hides the contract and
makes startup side effects harder to reason about.

Do not introduce a second config file shape just because it looks cleaner in
isolation. A new config filename is a product decision, not a local refactor.

For the Epicenter worked example, read
`specs/20260519T150000-epicenter-project-as-first-class.md`.

## File Organization Check

When the design changes ownership, sketch the current and proposed trees before
editing.

```txt
Current
packages/foo/
|-- lifecycle.ts
|-- lifecycle-options.ts
|-- cleanup.ts
`-- index.ts

Proposed
packages/foo/
`-- lifecycle.ts
```

Flatten stale directories when they only preserve an old concept. Rename files
when their owner changed. Keep a file split only when each file has a distinct
reason to exist for a new reader.

## Final Check

Before finishing, grep for old vocabulary, old shapes, old filenames, removed
exports, fallback parsers, stale comments, and examples. If old names still
appear outside historical specs or migration notes, the break is incomplete.

Then re-run the applicable section checks above instead of a recap list. If
any check fails, keep simplifying.
