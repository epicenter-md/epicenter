# PR Body Patterns

## When To Read This

Read when writing or reviewing a PR body: choosing a shape, opening it, picking headings, deciding what examples are mandatory, and applying the framing patterns that make a body durable. For the diagrams that go inside a body, see [visual-patterns.md](visual-patterns.md). For full worked bodies, see [examples.md](examples.md).

## Core Standard

A PR body is a durable explanation. The reader should understand what changed, why it matters, how to evaluate it, and what breaks without reconstructing the story from commits and file names.

Default mental model:

```txt
Thesis:    What changed, and why does it matter?
Example:   What does the new shape look like?
Mechanism: How should the reviewer or user understand it?
Contrast:  What changed from before?
Impact:    Breaking changes, migration, scope, review path.
```

For a small PR that sequence is two paragraphs. For a large one it becomes a heading-led guide. The sequence is constant; only the length changes.

## Open With Why, Not What

The single most common failure is opening with a list of what changed. The reader already has the Commits and Files Changed tabs. Lead with the motivation, then weave in the change.

Bad (changelog disguised as prose):

```md
## Summary
- Add shared auth factory
- Fix phantom TEncryption generic
- Remove runtime type checks
```

Good (motivation, then the change):

```md
Honeycrisp and opensidian both need the same auth: sign-in, sign-out, session, and key handling. Rather than duplicate it, this extracts a shared `createAuthState` factory that both apps consume with app-specific callbacks.
```

## Choose A Body Shape

Pick the lightest shape the change can survive in:

| Shape | Use when | Lead with | Must include | Avoid |
| --- | --- | --- | --- | --- |
| Focused fix | Narrow bug, small UI or internal fix | The user-visible failure | The mechanical fix in two or three sentences | Headings, test transcript |
| API or feature guide | New or changed exported function, type, CLI, HTTP route, config, or workflow | The smallest real call site | Call site, inferred types or output, migration note if call sites move | API prose with no example |
| Refactor or architecture guide | Ownership, composition, or package boundary changed but behavior is stable | The architectural pressure, in one sentence | Before and after shape, ownership tree, named trade-off | File lists, "cleaned up" with no contrast |
| Release notes | Versioned release, public surface needing docs, or body linked as migration context | Version number and a one-line theme | Contents list, per-feature example, breaking section with old and new | Process headings disguised as concepts |

### Focused Fix

No headings. Two or three paragraphs that name the user-visible problem and the mechanical fix:

```md
Drawers with long content overflow without scrolling, which makes it impossible to reach content below the fold on mobile.

Wrapping the rendered children in a `flex-1 overflow-y-auto` container fixes the layout. The drag handle keeps its natural height, and only the body becomes scrollable.
```

### API Or Feature Guide

Lead each feature with the smallest real example, then show the inferred types, generated output, or old and new usage so the reader can verify the contract without opening the diff. Concept headings are allowed here when they teach:

````md
Type-safe workspace actions are now defined once and mounted by each runtime.

## Define Actions

```ts
const actions = {
  posts: {
    create: defineMutation({
      input: type({ title: "string" }),
      handler: ({ title }) => client.tables.posts.create({ title }),
    }),
  },
};
```

The same action map drives CLI commands and HTTP routes:

```ts
const cli = createCLI(client, { actions });
const server = createServer(client, { actions });
```
````

### Refactor Or Architecture Guide

Open with the architectural pressure, not a file list. Show before and after, then a small ownership tree (see [visual-patterns.md](visual-patterns.md)) when composition changed:

````md
The old encryption path had five moving parts to answer one question: does this workspace have encryption keys?

```ts
// Before: three steps, async unlock, runtime state machine
const encryption = attachEncryption(ydoc, { encryptionKeys });
const tables = encryption.attachTables(defs);
await encryption.unlock(keys);
```

```ts
// After: keys are read during workspace construction
const workspace = createWorkspace({ id, keyring, tables: defs, kv: {} });
```
````

Add a review path only when reading order genuinely helps:

```md
1. Start with the public factory signature.
2. Read the runtime adapter that consumes it.
3. Skim one migrated caller as proof the shape works.
```

### Release Notes

A release body reads like documentation. Version heading, a contents list to jump by concept, the smallest example per feature, and a breaking section:

````md
# 1.2.0

Advancing programmable runtime types.

## Contents

- With Keyword
- Dependent Types
- Breaking

## With Keyword

```ts
const Email = Type.Script(`string with { format: "email" }`);
```

## Breaking

### Options Generic In Script

```ts
// Before
Type.Script("Options<string, { minLength: 10 }>");
// After
Type.Script(`string with { minLength: 10 }`);
```
````

This is not a loophole for generic process headings. The headings must be durable concepts: feature names, syntax names, migration topics, or breaking changes.

## Headings

Generic process headings are bad because they could appear in any PR:

```txt
Bad:  Summary | Changes | What Changed | Testing | Test Plan | Verification
Good: With Keyword | Dependent Types | Why A Flat API? | Migration | Breaking
```

`## Overview` is acceptable in release notes and public API guides. It is usually noise in ordinary reviewer notes. A `### Why X?` heading earns its place for a genuinely distinct design decision; keep it to one or two per large PR, not one per change.

## Required Examples

Code examples are mandatory for any PR that introduces or modifies new functions, types, or exports; function signatures; CLI commands or flags; HTTP endpoints; configuration; or scripting syntax.

Prefer examples that teach the contract:

```txt
Input syntax     -> generated schema
Factory call     -> returned handle
CLI command      -> effect
HTTP request     -> response shape
Before call site -> after call site
```

If the example does not make the contract clearer, cut it.

## Breaking Changes

Breaking changes need old and new examples. Do not bury them in prose. Name who is affected, what fails, and what to do instead:

````md
## Breaking

### Enum With Null

`Enum` no longer accepts `null`, because `Enum` is limited to values encodable by TypeScript enums.

```ts
// Before
Type.Enum([1, "hello", null]);
// After
Type.Enum([1, "hello"]);
```
````

## Diagrams

Use a diagram when it removes prose: ownership changes, runtime or data flow, protocol wire formats, module composition, or stacked-PR journeys. Default to the lightest form that carries the relationship, and never let prose run more than a short paragraph without a visual break. The full catalog, with a small example and a "when" for each, is in [visual-patterns.md](visual-patterns.md).

## Framing Patterns

These are thinking tools for finding the angle, not formulas. Use the one that fits.

### Disproportionate Complexity

State the simple question the old system answered, then contrast it with the machinery it required. The reader should think "that is absurd" before you show the fix.

```md
Good: The old encryption system had five moving parts to answer one question: does this workspace have encryption keys?
Weak: The encryption system was complex and needed simplification.
```

### Lead With What Dies

Use when deleting an established API surface is the point of the PR, especially when the change ripples across call sites. Open with the deletion verb naming the dying API, and show before and after in the first hundred words:

```md
This deletes `defineWorkspace` and the `withExtension` chain that drove every workspace for a year. The terminal API is `attach*` primitives composed inline against a Y.Doc the caller owns.
```

Two moves make it land:

- List every type or export that died as an explicit inventory. It lets the reader grep, and it forces you to verify the list is exhaustive.
- Name each survivor with the reason it earned its keep, in the same breath. Without that justification the reader assumes the survivor is leftover scaffolding and tries to delete it later.

Use this only when the deletion is the news. Additive features and refactors that do not touch call sites use the standard motivation-first opener. Counting callers is the test: if call sites do not change, this is the wrong framing.

### Name The One Regression

If a change trades something away, name it and quantify it with the payoff attached, before the reviewer finds it in the diff and reads it as an oversight. A scoped, named regression reads as judgment; an unmentioned one reads as a miss.

```md
The trade-off is that same-owner key rotation now needs a fresh `createWorkspace` call. That is acceptable because key rotation already rebuilds the authenticated workspace session.
```

### Bold Topic Sentences

For a PR with three or more distinct concerns, separate them with `---` and a bold topic sentence. These are not section headers; they are scannable anchors that let a reader skim the shape of the PR before reading it.

```md
---

**First, a small correction: SYNC_STATUS was documented as a heartbeat but it is not one.**

Liveness is already handled by text-level ping and pong. What SYNC_STATUS tracks is whether the client has local changes that have not reached the server yet.

---

**The message handler needed a cleaner return shape before RPC could be added.**

The old handler returned an optional-fields bag, and the caller had to guess which fields were set.
```

For simpler PRs, plain paragraphs are better.

### Came Along For The Ride

Use this to subordinate secondary improvements once the main story is done. It tells the reader the main narrative is over and these are bonuses, not side effects they need to trace back into the argument.

```md
Two follow-up improvements came along for the ride. First, cached session boot now applies persisted keys before the network roundtrip. Second, fingerprint dedup skips repeated HKDF derivation when the key set has not changed.
```

### Sequential Journey

Use when the work genuinely built on itself in stages. Tell the story in the order it happened so the reader follows the path you walked; each step should motivate the next.

```txt
End goal:      peer-to-peer RPC over the sync layer
Prerequisites: message result union
               status probe cleanup
               protocol routing
               typed action contracts
```

If the concerns are independent rather than sequential, use bold topic sentences instead.

## Stacked And Reviewer-Oriented PRs

When a stack is already split, write for the reviewer deciding where to spend attention. They care about the contract, the shape change, and the shortest honest review path, not a second changelog or a test transcript. Pressure test the body against:

- What contract stayed stable or changed?
- What one call site teaches the new shape?
- What ownership boundary should the reviewer grasp before reading files?
- Is there a best file order for reviewing the diff?

For a cleanup PR where the public surface stays stable, make the stability explicit first (show the unchanged call shape), then a tiny tree of what moved. For a stack, note the dependency: `Stacks on #1591; merge that first.`

## Closing Scope

For large PRs, end with a plain scope line, after the reader understands the story. Numbers mean nothing before the concepts are named.

```md
23 commits on top of the encryption branch. 61 files changed, +3571/-1048. Stacks on #1591; merge that first.
```

## What To Avoid

- `## Summary`, `## Changes`, `## Testing`, `## Test Plan`, and `## Verification` unless explicitly requested.
- Bullet lists that duplicate the Commits or Files Changed tabs.
- Changed-file inventories.
- API descriptions without call sites.
- Breaking changes without old and new examples.
- Corporate or marketing language.
- Apologizing for reasonable decisions.
- Over-explaining small fixes.
