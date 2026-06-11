# Result handling conventions for action call sites

**Date:** 2026-04-25
**Status:** proposed
**Depends on:** `specs/20260425T200000-actions-passthrough-adr.md` (passthrough action shape)

## TL;DR

When a `defineMutation` / `defineQuery` handler returns `Result<T, E>`, the call site has to choose: handle the error, drop it silently, or toast. This ADR documents which choice fits which call pattern, so new contributors don't re-derive it.

**Default**: handle the error: destructure `{ data, error }` or use `toastOnError` at the call site. **Exception**: high-frequency continuous mutations whose error is bug-class (e.g., `oninput` on a CRDT-write handler that exposes `TableParseError`). Per-call toasting on every keystroke would be worse UX than silent.

## Context

After `specs/20260425T200000-actions-passthrough-adr.md` landed, action handlers return their natural shape:

- Sync raw value
- Sync `Result<T, E>`
- Async raw value (`Promise<T>`)
- Async `Result` (`Promise<Result<T, E>>`)

Local callers see exactly that. Remote/AI/CLI consumers see the shape wrapped via `WrapAction<F>` (data unchanged; error union widens by `RpcError`).

For Result-returning handlers, fire-and-forget call sites discard the `Err` channel by default. That can be intentional (the error is unreachable in practice) or accidental (the author didn't think about it). The language doesn't distinguish. This ADR is the convention that does.

## Decision

Three categories of call sites, each with a default pattern:

### Category A: One-shot user-initiated mutations

Examples: `delete`, `restore`, `save`, `submit`, anything triggered by a confirmation dialog or a discrete button click.

**Convention**: `toastOnError(action(...), 'Friendly message')`.

Reader-friendly. Fires once per click. Surfaces real errors. No spam risk.

```ts
// apps/fuji/src/lib/components/EntryEditor.svelte
onConfirm: () => {
  toastOnError(
    fuji.actions.entries.delete({ id: entry.id }),
    'Couldn\'t delete entry',
  );
  goto('/');
}
```

### Category B: High-frequency continuous mutations on bug-class errors

Examples: `oninput` handlers on text fields that route through a CRDT write. The handler may return `Result<Row, TableParseError>`, but `TableParseError` only fires when stored CRDT data fails schema validation: bug-class, not user-actionable.

**Convention**: bare call. Add a code comment near the call (or in the helper that wraps it) noting why per-call toasting was rejected.

```ts
// EntryEditor.svelte
function updateEntry(updates: EntryUpdate) {
  // Bare call: TableParseError is bug-class (corrupted CRDT) and this
  // helper fires on every keystroke. Per-call toasting would spam.
  // See specs/20260425T230000-result-handling-conventions.md (Category B).
  fuji.actions.entries.update({ id: entry.id, ...updates });
}
```

### Category C: Real domain errors that callers must distinguish

Examples: `BrowserApiFailed` from `tabs.close`, network failures, validation errors. Caller logic depends on whether the operation succeeded.

**Convention**: destructure `{ data, error }` and branch.

```ts
const result = await actions.tabs.close({ tabIds: [123] });
if (result.error) {
  toastOnError(result, 'Couldn\'t close tabs');
  return;
}
const { closedCount } = result.data;
showSuccess(`Closed ${closedCount} tab${closedCount === 1 ? '' : 's'}`);
```

### Category D: Mixed-success operations

Examples: `savedTabs.save` returns `{ saved: true, closeResult }`: the save succeeded; the close-source-tab half may have failed.

**Convention**: branch on the inner Result.

```ts
savedTabState.save(tab).then((result) => {
  if (result?.closeResult.error) toastOnError(result.closeResult);
});
```

## Rationale

### Why not always destructure-and-handle?

Convention C is the most "honest": every Result deserves explicit handling. But applied uniformly, it produces UX disasters at high-frequency call sites. An `oninput` handler that toasts on every keystroke would spam the user during normal typing, on a bug-class error that should ideally surface once or not at all.

Convention B (bare call with comment) acknowledges that not every Result deserves the same ceremony. The comment is the signal that the silent discard is intentional.

### Why not throw-on-error inside the handler?

I.e., handler unwraps the Result, throws on Err, returns raw. Considered and rejected:

1. **Loses typed error information**. Remote/AI/CLI consumers see `Err(ActionFailed{cause: TableParseError})` (one layer of wrapping) instead of `Err(TableParseError)` directly. The error union widening becomes lossy.
2. **Throws are dishonest**. The handler "could throw" semantically, but most call sites don't `try/catch` because TableParseError is bug-class. An untyped throw is strictly worse than a discarded typed Err.
3. **Doesn't actually solve the silent-discard smell**. The smell at the call site moves from "silent Result drop" to "uncaught exception." Same failure mode, different surface.

### Why not add a custom ESLint rule for unused Results?

Considered:

- ESLint has `@typescript-eslint/no-floating-promises` for Promises.
- Could write an analogous `no-unused-result` rule based on type analysis.
- wellcrafted's `Result<T, E>` is structurally typed: no brand. The rule would have to detect `{ data: T | null; error: E | null }` signatures.

Rejected for cost-benefit:

- Surface area is small (3 sites in Fuji, a handful in tab-manager).
- Half of the Result returns *should* be silent (Category B). The rule would either fire false positives or need a per-call escape hatch.
- Lint plumbing investment is real; payoff is low.

If the action surface grows substantially (10x current size) or unused-Result becomes a recurring bug source, revisit.

### Why not auto-toast in state wrappers?

I.e., have `entriesState.update(...)` internally call `toastOnError`. Considered and rejected:

- Re-introduces the wrapper layer that we just simplified.
- Couples error UX to state files. Components lose the ability to choose differently per call.
- Doesn't solve Category B (high-frequency calls would still spam).

## Consequences

- Each new mutation call site picks a category and follows the matching pattern.
- Handler authors are encouraged to document expected error shapes (bug-class vs user-actionable) in JSDoc, so call site authors know which category applies.
- Code review can ask "which category is this?": if the answer is unclear, the call site needs a comment.
- Future contributors don't have to re-derive the convention.

### Per-action category table

| Action | Handler error type | Category | Call-site pattern |
|---|---|---|---|
| `fuji.entries.create` | (raw, no Result) | n/a | bare call |
| `fuji.entries.update` | `TableParseError` | B (bug-class, oninput) | bare call |
| `fuji.entries.delete` | `TableParseError` | A (one-shot) | `toastOnError` |
| `fuji.entries.restore` | `TableParseError` | A | `toastOnError` |
| `fuji.entries.bulkCreate` | (raw, no Result) | n/a | bare call |
| `tabManager.tabs.close` | `BrowserApiFailed` | C | destructure + branch |
| `tabManager.tabs.open` | `BrowserApiFailed` | C | destructure + branch |
| `tabManager.savedTabs.save` | mixed return (`closeResult`) | D | branch on `result.closeResult.error` |
| `tabManager.savedTabs.restore` | `BrowserApiFailed` | C | `toastOnError` |
| `tabManager.bookmarks.open` | `BrowserApiFailed` | C | `toastOnError` |
| `tabManager.savedTabs.remove` | (raw, no Result) | n/a | bare call |

## Open questions

- The "high-frequency continuous mutation" pattern is brittle. The single call site (`fuji.entries.update` via `oninput`) is the only Category B example today. If that pattern proliferates, we may need a structural fix (debounced update, commit-on-blur, doc-corruption observer) rather than per-call discipline. Tracked separately; see follow-up notes after this ADR.
- `toastOnError`'s behavior on raw values (non-Result) is no-op-y. The convention assumes `toastOnError(actionResult, message)` where the result IS a Result. If a future handler is changed from Result-returning to raw, calling `toastOnError` on it silently no-ops: a regression that lint can't catch. Mitigation: code review when handler shapes change.

## Cross-references

- `specs/20260425T200000-actions-passthrough-adr.md`: the action-shape decision this convention sits on top of.
- `apps/fuji/src/lib/components/EntryEditor.svelte`: Category A (`delete`) and Category B (`update`) examples.
- `apps/fuji/src/routes/trash/+page.svelte`: Category A (`restore`) example.
- `apps/tab-manager/src/lib/components/tabs/UnifiedTabList.svelte`: Category C (`restore`, `open`) examples.
- `apps/tab-manager/src/lib/components/tabs/TabItem.svelte`: Category D (`savedTabs.save` mixed return) example.
