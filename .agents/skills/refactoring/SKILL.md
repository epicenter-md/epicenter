---
name: refactoring
description: Systematic code audit and refactoring methodology—caller counting, type safety boundaries, inlining single-use extractions, collapsing duplicate branches, and surgical commits. Use when cleaning up code, auditing for code smells, refactoring modules, or reviewing internal function structure.
metadata:
  author: epicenter
  version: '1.0'
---

# Refactoring Methodology

Systematic approach to auditing and improving code. Every change is evidence-based—count callers, show diffs, commit surgically.

> **Related Skills**: See `control-flow` for linearizing conditionals and guard clauses. See `factory-function-composition` for the four-zone factory anatomy. See `method-shorthand-jsdoc` for when to use `this.method()` vs direct calls.

## When to Apply This Skill

Use this methodology when you need to:

- Audit a module for code smells or unnecessary abstractions
- Inline single-use helper functions
- Eliminate raw/untyped access that bypasses a typed boundary
- Collapse duplicate switch/if branches that do the same thing
- Refactor function signatures (positional params → parameter objects)
- Derive types instead of duplicating fields

## The Audit: Count Callers First

Before changing anything, map every internal function with its exact call count.

```
INTERNAL FUNCTIONS                          CALLERS
────────────────────────────────────────────────
lastEntry()                                 5  (currentType, validated, 3× replace*)
validated()                                 6  (getter, read, appendText, asText, asRichText, asSheet)
pushText(content)                           8  (write, appendText×3, asText×3, replace)
replaceCurrentText(content)                 1  ← restoreFromSnapshot only ⚠️
pushSheetFromSnapshot(cols, rows)           1  ← restoreFromSnapshot only ⚠️
```

**1 caller = inline candidate.** Always ask: does this function earn its name?

### Decision Table

| Callers | Action |
|---|---|
| 0 | Dead code. Delete. |
| 1 | Inline candidate. Keep only if: complex logic worth naming, part of a constructor family, or carries important JSDoc. |
| 2–3 | Evaluate. If all callers are in the same method, might still inline. |
| 4+ | Keep. |

### When to Keep a Single-Caller Function

Not every 1-caller function should be inlined. Keep it when:

- **Part of a family**: `pushText`, `pushSheet`, `pushRichtext` all follow the same structure. Inlining one breaks the visual symmetry.
- **Complex logic worth naming**: Deep-clone operations, recursive tree walks, or multi-step parsing where the name documents intent.
- **The calling method is already long**: Inlining 15 lines into a 50-line method hurts readability.

## Type Safety Boundaries

All raw/untyped access should go through a single parsing boundary. Everything downstream uses typed results.

```
BAD: Multiple raw access points scattered across methods
─────────────────────────────────────────────────────────
currentType getter  → entry.get('type') as ContentType     ← raw .get() + cast
write()             → entry.get('columns') as Y.Map<...>   ← raw .get() + cast
replaceCurrentText  → entry.get('content') as Y.Text       ← raw .get() + cast

    GOOD: Single boundary, everything else uses typed discriminated union
    ───────────────────────────────────────────────────────────────────
readEntry()         → entry.get('type'), instanceof checks  ← THE boundary
    currentEntry getter → readEntry(last)                       ← typed from here
    write()             → this.currentEntry (discriminated)     ← typed
read()              → this.currentEntry (discriminated)     ← typed
```

    Fix: route all access through the typed getter. Public methods use `this.currentEntry` with type discrimination instead of raw `.get()`.

## Collapsing Duplicate Branches

When a switch has 2+ branches doing the same thing with different inputs, collapse via a shared method.

### The Tell

If you can describe two branches with the same sentence, they're duplicates.

```typescript
// BEFORE: "flatten to string and push" appears twice
switch (entry.type) {
	case 'richtext':
		pushText(xmlFragmentToPlaintext(entry.content) + text);
		break;
	case 'sheet':
		pushText(serializeSheetToCsv(entry) + text);
		break;
}

// AFTER: this.read() already does "flatten to string"
} else {
	pushText(this.read() + text);
}
```

 Also applies to `as*()` conversion methods. If every non-matching branch does "read as string → push as target type", collapse:

         ```typescript
// BEFORE: 3 cases, 2 are near-identical
asRichText(): Y.XmlFragment {
	const entry = this.currentEntry;
	if (!entry) return ydoc.transact(() => pushRichtext()).content;
	switch (entry.type) {
		case 'richtext':
			return entry.content;
		case 'text': {
			const plaintext = entry.content.toString();
			return ydoc.transact(() => { /* push richtext from plaintext */ }).content;
		}
		case 'sheet': {
			const csv = serializeSheetToCsv(entry);
			return ydoc.transact(() => { /* push richtext from csv */ }).content;
		}
	}
}

// AFTER: Same-type early return + single conversion path
asRichText(): Y.XmlFragment {
	const entry = this.currentEntry;
	if (!entry) return ydoc.transact(() => pushRichtext()).content;
	if (entry.type === 'richtext') return entry.content;
	const plaintext = this.read();
	return ydoc.transact(() => {
		const { content } = pushRichtext();
		populateFragmentFromText(content, plaintext);
		return { content };
	}).content;
}
```

## Composition Over Duplication

When function B is function A + one extra step, compose instead of duplicating:

```typescript
// BEFORE: pushSheetFromCsv duplicates 90% of pushSheet's body
function pushSheet(): SheetEntry { /* 10 lines of Y.Map setup */ }
function pushSheetFromCsv(csv: string): SheetEntry {
	/* same 10 lines of Y.Map setup */
	parseSheetFromCsv(csv, columns, rows);
}

    // AFTER: Compose
    const result = pushSheet();
parseSheetFromCsv(csv, result);
```

## Inline Known-Behavior Calls

    When a "smart" function branches internally but every caller already knows which branch it takes:

```typescript
// replaceCurrentText branches on type, but callers know the answer:
function replaceCurrentText(content, current) {
	if (current?.type === 'text') { /* in-place overwrite */ }
	else { pushText(content); }
}

// write() KNOWS it's text → always takes the if-branch
// appendText() KNOWS it's NOT text → always takes the else-branch
```

    Inline the known branch at each call site. Keep the branching function only for callers that genuinely don't know (e.g., `restoreFromSnapshot` where the live doc's type is unknown).

## Parameter Objects and Type Derivation

### Parameter Objects

When 2+ params always travel together and a type already describes them:

```typescript
// BEFORE
serializeSheetToCsv(entry.columns, entry.rows)

// AFTER: SheetBinding already bundles columns + rows
serializeSheetToCsv(entry)
```

### Type Derivation

Derive types instead of duplicating fields:

```typescript
// BEFORE: columns/rows duplicated in both types
type SheetBinding = { columns: Y.Map<...>; rows: Y.Map<...> };
type SheetEntry = { type: 'sheet'; columns: Y.Map<...>; rows: Y.Map<...>; createdAt: number };

// AFTER: Intersection
type SheetEntry = SheetBinding & { type: 'sheet'; createdAt: number };
```

## Presenting Changes

Always show the proposed change as a diff with tradeoffs before implementing:

```
Proposed: inline replaceCurrentSheet into write()

 write(text: string) {
     ydoc.transact(() => {
-        if (type === 'sheet') replaceCurrentSheet(text);
+        if (type === 'sheet') {
+            entry.columns.forEach((_, key) => entry.columns.delete(key));
+            entry.rows.forEach((_, key) => entry.rows.delete(key));
    +            parseSheetFromCsv(text, entry);
+        }

Tradeoff: write() goes from 6 to 14 lines, but is now self-contained.
```

State what gets better AND what gets worse. Let the reviewer decide.

## Surgical Commits

One logical change per commit. Test between each.

```
    edit → diagnostics → test → commit → next edit
    ```

Never mix two unrelated refactors in one commit:

```
98fcabe  refactor: inline ValidatedEntry type and single-use write helpers
af643fd  refactor: replace validated()/currentType() closures with this.currentEntry
19d108a  refactor: remove pushSheetFromCsv, compose pushSheet + parseSheetFromCsv
c4f8ddc  refactor: move SheetBinding to sheet.ts, accept as single param
```

## Anti-Patterns

- **Premature extraction**: Extracting a function used once that doesn't add clarity over inline code
- **Abstracting away differences**: Three push constructors with different fields share boilerplate, but a `pushEntry(type, fields: Record<string, unknown>)` helper loses all type safety. The duplication communicates structure.
- **Type-erasing helpers**: Any helper that accepts `unknown` or `Record<string, any>` to "reduce duplication"
- **Refactoring while fixing bugs**: Fix the bug minimally first, refactor in a separate commit
- **Batch-committing**: "Cleaned up the module" as one commit with 15 changes—impossible to review or revert
- **Shotgun inlining**: Inlining everything with 1 caller regardless of context. Respect constructor families and complex logic.
