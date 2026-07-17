---
name: first-read-review
description: First-read approachability lens. Read code as a newly onboarded TypeScript developer to surface indirection, misleading names, type-system-only tricks, and wrong-owner boundaries. Cited by post-implementation-review and collapse-pass as their readability pass; also use directly when code feels clever or hard to follow on first read.
---

# First-Read Review

Read the code like a smart but newly onboarded TypeScript developer.

Related skills: use `post-implementation-review` for the full second-read
ritual after implementation, `refactoring` for caller counting and inlining
mechanics, and `greenfield-clean-breaks` when a readability issue points to the
wrong public boundary.

The goal is not "make it shorter" or "make it more abstract." The goal is:

- make the first read cheaper
- make ownership boundaries obvious
- remove tricks that only exist for the type system
- keep real domain or validation boundaries intact

## What to Look For

- Names that imply a more important concept than the code actually represents
- Types that pretend to be runtime truths but are only inference shims
- Client-only hacks living in server packages, or server concerns leaking into browser/shared code
- Single-use helpers that hide simple control flow
- Tiny wrappers that add vocabulary but not clarity
- Multiple files for one concept when readers really need one place to look
- "Smart" generic helpers where direct code would be easier to trust
- Ad-hoc `as` assertions outside a clear parse or interop boundary
- JSDoc that restates code instead of explaining why the boundary exists

## What Not to "Fix"

- Real parse boundaries at JSON, file, or network edges
- Runtime validation that protects unsafe input
- Shared contracts that genuinely belong in one place
- Repetition that is cheaper than an extra abstraction

## Review Method

1. Start with the entrypoint a caller uses first.
2. Trace the minimum path needed to understand the behavior.
3. Count the hops:
   - if understanding one field or behavior requires jumping across multiple files, ask whether that indirection earns its keep
4. Mark each abstraction as one of:
   - `earns its keep`
   - `probably inlineable`
   - `wrong ownership boundary`
   - `misleading name`
   - `type-system workaround`
5. Prefer fixes that:
   - move code to the right owner
   - rename things honestly
   - collapse fake layers
   - replace cleverness with one explicit boundary

## Output Shape

When reporting findings, prioritize:

1. The one or two biggest readability or ownership smells
2. Why a new TypeScript developer would stumble there
3. The greenfield correction that would make the code easiest to trust

When editing code:

- keep commits surgical
- add or improve JSDoc on public boundaries
- do not add a new abstraction unless it reduces total cognitive load
- prefer explicit names like `*Bridge`, `*Contract`, `*Parser`, `*Factory`, `*State`

## Heuristics

### Good smell

```ts
export type SessionContract = { ... };
```

Portable type, honest name, obvious job.

### Bad smell

```ts
export type AppAuth = {
  options: { plugins: [...] }
};
```

If this is not the real auth type, do not name it like it is.

### Good workaround

```ts
export type CustomSessionClientBridge = { ... };
```

If a library forces a type trick, keep it local and name it as a bridge.

## Go-to-Definition Is the First Read

A new developer's first read of a foreign symbol is Go-to-Def. Treat it as the canonical readability tool: pressing it from a call site should land on the actual source of truth in as few hops as possible. Counting hops (review method, step 3) means counting Go-to-Def hops.

The smell catalog that bloats the hop count (re-export chains,
destructure-re-exports, no-op adapters, identity-obscuring annotations) lives in
[typescript](../typescript/SKILL.md) "Go-to-Definition Awareness". Each extra hop
has to earn its keep: if a layer doesn't own a real invariant, name non-obvious
domain behavior, or isolate unsafe input, collapse it.

## Success Criteria

The code should leave a new teammate thinking:

- "I know which file owns this concept."
- "I know which type is a real contract and which one is just library glue."
- "I don't have to reverse-engineer the architecture from naming accidents."
