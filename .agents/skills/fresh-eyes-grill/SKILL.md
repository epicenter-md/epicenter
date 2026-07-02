---
name: fresh-eyes-grill
description: Fresh-context adversarial review for staged diffs, state machines, type shapes, lifecycle boundaries, and confusing abstractions. Use when the user says "fresh eyes", "grill this", "why not simpler", "state-machine audit", "does this type shape earn it", or asks for a new-developer review through a subagent. Compose with greenfield-clean-breaks only when compatibility pressure has been explicitly released.
---

# Fresh Eyes Grill

Use this skill when the current implementer may be too close to the design.
The job is to read the change like a capable TypeScript developer who has not
been part of the conversation, then push until the lifecycle, names, and type
shapes either become obvious or collapse to something simpler.

This is not a normal code review. It is a structured challenge pass.

## Required Starting Move

When the runtime supports subagents and the user has asked for fresh eyes, spawn
a fresh-context reviewer. Do not fork the whole conversation unless the user
explicitly asks for continuity. Give the subagent a bounded prompt with:

- exact files to read
- staged diff or target branch to inspect
- hard invariants
- skills to load
- expected output shape

If subagents are not available, simulate the same posture locally: read only the
files named by the task first, then widen by caller search only when a question
requires it.

Always load the relevant local skills before reviewing:

- `typescript` for type ownership, local shape copies, and discriminated unions
- `approachability-audit` for first-read clarity
- `refactoring` for caller counts and helper inlining
- `cohesive-clean-breaks` for refusing low-value behavior or states
- `greenfield-clean-breaks` when the user says "greenfield", "no users",
  "clean break", "refuse compatibility", or asks whether old behavior can be
  deleted
- `define-errors` and `error-handling` when `Result`, `Err`, `Ok`, or
  `defineErrors` shapes are involved
- `collapse-pass` when the user asks to shrink indirection or delete state
- the domain skill for the package being reviewed, such as `auth`,
  `workspace-api`, `svelte`, or `tauri`

## The Posture

Assume the code might be right, but the explanation might still be too
expensive. Your job is to make the design earn its shape.

Ask these questions in order:

1. What is the one sentence this code must make true?
2. Which values are durable state, which values are runtime state, and which
   values are just network observations?
3. Which layer owns each invariant?
4. What would a new developer misunderstand on the first read?
5. What is the simplest design that would still satisfy the hard invariants?
6. If compatibility pressure has been released, what behavior can we refuse to
   delete a whole code family?
7. Which helpers have one caller, and do they earn their names?
8. Which type aliases are real contracts, and which are local ceremony?
9. Would `Result` plus `defineErrors` say this better than a custom union?
10. Are tests asserting public behavior or implementation trivia?

Do not accept "it is explicit" as a sufficient answer. Explicit code can still
be the wrong boundary. Judge whether a state, helper, or type earns its place
with the [radical-options](../radical-options/SKILL.md) keep list rather than
an ad hoc standard.

## Type Shape Rules

Prefer existing project conventions before inventing a local protocol.

- Use `Result<T, E>` for success or failure.
- Use `defineErrors` for typed failure modes.
- Use a custom discriminated union when every variant is a successful domain
  state, or when the union models runtime state rather than operation failure.
- Do not wrap `Result` in another success/error union unless there is a clear
  third state that is not success and not failure.
- Do not create a named type alias just to make a short return annotation unless
  the alias names a real contract.

Healthy examples:

```ts
type RuntimeAuthState =
	| { status: 'signed-out' }
	| { status: 'signed-in'; networkAccess: NetworkAccess };

type ApiSessionRequestResult = Result<
	ApiSessionResponse,
	ApiSessionRequestError
>;
```

Suspicious example:

```ts
type ApiSessionResult =
	| { status: 'ok'; session: ApiSessionResponse }
	| { status: 'auth-rejected'; error: AuthError }
	| { status: 'unavailable'; error: AuthError };
```

The suspicious version makes a second result protocol. Prefer `Result` unless
the extra state is genuinely not an error.

## Lifecycle Grill

For state machines, write the lifecycle before reviewing code:

```txt
boot
  -> state A
  -> state B

network request
  -> gate
  -> verification
  -> success or refusal

teardown
  -> stop trust
  -> clear durable state
  -> discard stale work
```

Then challenge every transition:

- What starts this transition?
- What async work can still be in flight?
- What object identity or version gate prevents stale work from winning?
- What state is public, and what state is only internal?
- What happens if durable storage fails?
- What happens if the network lies, times out, or returns stale identity?

If a transition cannot be explained in one short line, it needs a better name,
a better invariant, or fewer states.

## Helper Boundary Grill

Count callers before judging helpers.

```txt
helper                           callers  decision
currentThing                     6        keep
makeInitialState                 1        keep if it names boot semantics
normalizeResult                  1        inline unless it isolates unsafe input
```

Judge each one-caller helper with the [refactoring](../refactoring/SKILL.md)
caller-count table and single-caller reasons; inline helpers that only rename
simple control flow.

## Output Shape

Use this shape for the final review:

```txt
Files read
path/
|-- file-a.ts
`-- file-a.test.ts

Lifecycle
...

Findings
1. [severity] file:line Problem, why it matters, correction.

Would simplify
- ...

Would keep
- ...

Test gaps
- ...

Verdict
Keep / change / block, with one concrete reason.
```

Findings must lead. Do not bury bugs under prose.

## When Editing

If the user asks you to act on the grill:

1. Add or adjust focused tests first.
2. Make the correction that resolves the problem at its real owner. Use
   `greenfield-clean-breaks` only when compatibility pressure has been
   explicitly released.
3. Re-read every touched file.
4. Run package typecheck and tests.
5. Stage only the files you touched when the user asks for staging.

Do not fold unrelated cleanup into the change. Fresh eyes does not mean wider
scope.
