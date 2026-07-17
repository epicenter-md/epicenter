---
name: change-proposal
description: 'Present proposed code changes visually before implementing: before/after diffs, ASCII diagrams, comparison tables. Use when: "show me options for this change", "compare approaches", or a multi-file change needs a before/after comparison before editing. Not for planning questions with no concrete code change on the table.'
---

# Change Proposal

When proposing non-trivial changes, make your reasoning visible before acting. The user should see what will change, why, and what alternatives were considered, before a single file is edited.

Follow [writing-voice](../writing-voice/SKILL.md) for prose sections.


## The Three Tools

### 1. Before/After Diffs

Show what specific code will change. Use fenced diff blocks with file paths.

````diff
--- a/workspace.ts
+++ b/workspace.svelte.ts
@@ createWorkspaceState()
-    let client = buildWorkspaceClient();
+    let client = $state(buildWorkspaceClient());
     return {
         get current() { return client; },
-        async reset() {
-            await client.wipe();
-            client = buildWorkspaceClient();
+        async reset(options?: { key?: Uint8Array }) {
+            await client.dispose();
+            client = buildWorkspaceClient(options);
         },
     };
````

Rules:
- Show the smallest meaningful diff, not the whole file
- Include enough context lines (3-5) to understand placement
- Group related changes together, separate unrelated ones
- Label each diff with the file path and function/scope

### 2. ASCII Architecture Diagrams

Show how components relate before and after the change. Use these characters: `┌ ┐ └ ┘ ─ │ ├ ┤ ┬ ┴ ┼ ▼ ▲ ──→ ←──`

**Before:**
```
auth ──signOut()──→ workspace.reset() ──→ internally rebuilds
                         │ (self-manages lifecycle)
                         ├── dispose()
                         ├── wipe()
                         └── client = build()
```

**After:**
```
auth ──signOut()──→ workspace.current.dispose()
                    setWorkspaceClient(build())
                         │
          workspace is a reactive slot ← auth owns lifecycle
```

Default to an ownership diagram: who controls what, with arrows showing control flow. Reach for stacked layers, a data-flow shape, or an attempt A → B → C journey only when ownership is not the question being decided.

### 3. Comparison Tables

When multiple approaches exist, present them as a table with clear trade-off dimensions.

```
                   A: Self-managed    B: Slot + builder    C: Auth owns state
                   ───────────────    ─────────────────    ──────────────────
Who holds $state?  workspace          workspace            auth
Who decides wipe?  workspace          auth (explicit)      auth (explicit)
Circular deps?     same as today      same as today        WORSE
God module risk?   workspace          neither              auth
```

Rules:
- Rows are dimensions the user cares about
- Columns are approaches
- Use short phrases, not sentences
- State your recommendation after the table, not inside it

## Proposal Structure

For non-trivial changes, present in this order:

1. **One sentence**: What you're proposing and why
2. **Diagram**: Architecture before/after (or competing approaches side-by-side)
3. **Diffs**: Concrete code changes for the recommended approach (hardest file first)
4. **Trade-offs**: What you gain, what you lose, what stays the same
5. **Ask**: "Should I proceed with [recommendation], or prefer [alternative]?"

## Scaling by Complexity

| Change scope | What to show |
| --- | --- |
| 1 file | Just the diff, no diagram |
| 2-5 files | Diff of the hardest file + one diagram showing relationships |
| 5+ files | Full proposal: comparison table, diagrams, diffs for hardest 2-3 files |
| Architecture decision | Comparison table mandatory, even if only 2 options |
| Competing approaches | All three tools: diagram per approach, diff per approach, comparison table |

## Good vs Bad Proposals

### Good

> `workspace.ts` currently self-manages its lifecycle. I'd split it: workspace becomes a reactive slot + builder, auth owns the lifecycle decisions.
>
> ```
>               writes                    reads
> auth ──────────────────► workspace.svelte.ts ◄──── consumers
>    builds, sets           let client = $state()     .current
>    decides wipe           set(newClient)             via $effect
> ```
>
> ```diff
> --- a/workspace.ts (createWorkspaceState)
> +++ b/workspace.svelte.ts
> -    let client = buildWorkspaceClient();
> +    let client = $state(buildWorkspaceClient());
> ```
>
> Trade-off: auth gains 10 lines of explicit lifecycle code, workspace loses its god-object methods. Net simpler because lifecycle decisions are visible at the call site.
>
> Should I proceed with this, or keep workspace self-managed?

### Bad

> I'll refactor workspace.ts to use a slot pattern and move lifecycle management to auth.svelte.ts. This involves changing how the client is created and disposed, updating the state management to use $state, and modifying the reset function to accept an optional key parameter. The consumers will use $effect to automatically rebind when the workspace changes.

The bad version describes changes in prose. The good version shows them.

## What to Avoid

- **Prose-only proposals**: If you can draw it, draw it. If you can diff it, diff it.
- **Showing every file**: Show the hardest 2-3. Mention the rest as "same pattern."
- **Burying the recommendation**: Lead with your pick, then show alternatives.
- **Fake precision**: Don't show a diff for code you haven't read yet. Read first, then diff.
