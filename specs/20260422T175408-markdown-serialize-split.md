# Markdown Materializer: Split `serialize`/`deserialize` into Orthogonal Slots

**Date**: 2026-04-22
**Status**: Draft
**Author**: AI-assisted
**Branch**: (target: braden-w/document-primitive or successor)

## Overview

Replace the markdown materializer's asymmetric `serialize: (row) → { filename, content }` / `deserialize: ({ frontmatter, body }) → row` pair with three orthogonal slots: `filename(row)`, `format(row) → { frontmatter, body }`, and `parse({ frontmatter, body }) → row`. The new shape makes round-trip identity expressible at the type level and separates "where a row lives on disk" from "how a row serializes to markdown."

## Motivation

### Current State

```ts
.table(tables.posts, {
  // Returns a BUNDLED filename + content blob
  serialize: async (row) => ({
    filename: toSlugFilename(row.title, row.id),
    content: toMarkdown({ id: row.id, title: row.title }, row.body),
  }),
  // Takes the PARSED markdown structure (frontmatter + body), not content
  deserialize: (parsed) => ({
    id: parsed.frontmatter.id as string,
    title: parsed.frontmatter.title as string,
    body: parsed.body ?? '',
    _v: 1,
  }),
});
```

### Problems

1. **The two halves speak different dialects.**
   - `serialize` outputs `{ filename, content }`: a filesystem concept.
   - `deserialize` takes `{ frontmatter, body }`: a markdown concept.
   - They're not inverses in any type-checkable sense. You can pass files through a round-trip and break invariants without the compiler noticing.

2. **Three concerns are conflated in one function (`serialize`).**
   - *Filename choice* (pure, synchronous, needs only `row.id` or `row.title`)
   - *Frontmatter shape* (which row fields become YAML keys)
   - *Body content* (how the row's content-ish field becomes the markdown body)
   - Callers who only want to change filename have to rewrite the whole serialize, duplicating the default `toMarkdown` call. See `playground/opensidian-e2e/epicenter.config.ts:115-149`: 35 lines of serialize just to compute a slug filename.

3. **No round-trip identity check.** With a cleanly-split `format` / `parse` pair, a test could assert `parse(format(row)) === row` at the type level. Today there's no contract linking them.

4. **`deserialize` is optional and defaults to "use frontmatter as row."** Fine for simple cases, but obscures the true contract: the default IS a parser (`frontmatter → row`), it's just implicit. A `parse` slot with a default makes this explicit.

### Desired State

```ts
.table(tables.posts, {
  // Where to write: pure, sync
  filename: (row) => toSlugFilename(row.title, row.id),

  // How to format: row → { frontmatter, body }
  toMarkdown: (row) => ({
    frontmatter: { id: row.id, title: row.title },
    body: row.content,
  }),

  // Inverse of toMarkdown: { frontmatter, body } → row
  fromMarkdown: (parsed) => ({
    id: parsed.frontmatter.id as string,
    title: parsed.frontmatter.title as string,
    content: parsed.body ?? '',
    _v: 1,
  }),
});
```

Three slots, each takes exactly one callable. `toMarkdown` and `fromMarkdown` are true inverses over a shared `MarkdownShape` type. `filename` is its own pure slot. The materializer composes them: `writeFile(filename(row), assembleMarkdown(toMarkdown(row)))`.

For common patterns like "one field is the body," ship **two independent helpers**: never a bundled pair:

```ts
.table(tables.posts, {
  filename: slugFilename('title'),
  toMarkdown: fieldAsBody('content'),     // row → put `content` in body
  fromMarkdown: bodyAsField('content'),   // body → put in row.content
});
```

Each helper returns one callable for one slot. No spread magic, no bundled `{ toMarkdown, fromMarkdown }` pair, no precedence rules. The config object always has exactly the same three optional keys, and every value is a callable you can point at.

## Research Findings

### What patterns exist in similar tools

| Tool                 | Filename control                        | Content serialization           | Round-trip symmetry |
| -------------------- | --------------------------------------- | ------------------------------- | ------------------- |
| Obsidian plugins     | Filename = title (convention)           | Frontmatter + body (separate)   | Yes                 |
| gatsby-remark        | Filename = slug                         | Frontmatter + body (separate)   | Yes                 |
| 11ty                 | Filename = data.page.fileSlug           | Frontmatter + body (separate)   | Yes                 |
| gray-matter (lib)    | N/A (doesn't own filenames)             | `{ data, content }` pair        | Yes: its core idiom |
| **Current markdown materializer** | Bundled with serialize       | Bundled with serialize          | No                  |

**Key finding**: everyone else treats filename, frontmatter, and body as three separate concerns. The bundled `serialize → { filename, content }` is our own non-idiom.

**Implication**: the split isn't a judgment call, it's catching up to how every other markdown tooling structures the problem.

### `gray-matter` as an API model

Grey-matter's core types:
```ts
matter(markdown: string): { data, content }
matter.stringify(content, data): string
```

These are straight inverses. Our `parse` / `format` will mirror this shape, using `frontmatter` instead of `data` because that's the term we already use in the parse path.

## Design Decisions

| Decision                         | Choice                                              | Rationale                                                    |
| -------------------------------- | --------------------------------------------------- | ------------------------------------------------------------ |
| Slot names                       | `filename`, `toMarkdown`, `fromMarkdown`            | Self-documenting in autocomplete ("produces markdown" / "consumes markdown"). `filename` stays its own concern. |
| `serialize`/`deserialize`        | **Deleted in this cut** (no alias, no legacy path)  | Migration is small (playground + tests). Aliases add surface area without earning it. |
| Internal helper `toMarkdown(fm, body)` | Rename to `assembleMarkdown`                  | Frees the `toMarkdown` name for the config slot.             |
| Default `filename`               | `(row) => `${row.id}.md``                           | Current behavior preserved.                                  |
| Default `toMarkdown`             | `(row) => ({ frontmatter: row, body: undefined })`  | Current behavior (dump row as frontmatter, no body).         |
| Default `fromMarkdown`           | `(parsed) => parsed.frontmatter as Row`             | Current behavior (frontmatter-is-row).                       |
| Shared type for pair             | `MarkdownShape = { frontmatter: Record<string, unknown>; body: string | undefined }` | Symmetric; `Parameters<fromMarkdown>[0]` === `ReturnType<toMarkdown>`. |
| Common-case helpers              | `fieldAsBody(field)` and `bodyAsField(field)`: **two independent helpers**, never a bundled pair | Each returns one callable for one slot. No spread, no `bodyField` config slot, no precedence rules. The config always has exactly 3 optional keys. |
| Filename for a row with no `id`  | Enforced: row must always have an id (BaseRow requires it) | No changes to the id invariant.                              |
| Async callbacks?                 | Allow `MaybePromise` on all three slots             | Matches existing `serialize` async semantics; needed when the transform depends on a lookup. |

## Architecture

### Before

```
┌─────────────────────────────┐
│  row                        │
└─────────────────────────────┘
            │
            ▼
   serialize(row)
            │
            ▼
┌─────────────────────────────┐
│  { filename, content }       │ ← bundled, non-inverse shape
└─────────────────────────────┘
            │
            ▼
        writeFile
```

### After

```
┌─────────────────────────────┐
│  row                        │
└─────────────────────────────┘
     │             │
     │             ▼
     ▼          format(row)   ─────┐
filename(row)     │                │
     │            ▼                │
     │   ┌──────────────────┐      │
     │   │ { frontmatter,   │ ◄────┤  symmetric shape
     │   │   body }          │      │
     │   └──────────────────┘      │
     │            │                │
     │            ▼                │
     │         toMarkdown          │
     │            │                │
     ▼            ▼                │
┌─────────────────────────────┐    │
│  join(dir, filename)        │    │
│  writeFile(content)         │    │
└─────────────────────────────┘    │
                                   │
  (push path: readFile → parseMarkdownFile → { frontmatter, body } → parse → row)
                                   │
                                   ▼
                           parse(parsed) → row
```

### Type shape

```ts
export type MarkdownShape = {
  frontmatter: Record<string, unknown>;
  body: string | undefined;
};

type TableConfig<TRow extends BaseRow> = {
  dir?: string;
  filename?: (row: TRow) => MaybePromise<string>;
  toMarkdown?: (row: TRow) => MaybePromise<MarkdownShape>;
  fromMarkdown?: (parsed: MarkdownShape) => MaybePromise<TRow>;
};

// Helpers live in serializers.ts
export function fieldAsBody<TRow extends BaseRow>(
  field: keyof TRow & string,
): (row: TRow) => MarkdownShape;

export function bodyAsField<TRow extends BaseRow>(
  field: keyof TRow & string,
): (parsed: MarkdownShape) => TRow;
```

## Implementation Plan

### Phase 1: Type + internal plumbing

- [ ] **1.1** Rename the internal `toMarkdown(frontmatter, body): string` helper in `markdown.ts` to `assembleMarkdown` so the config slot name is free.
- [ ] **1.2** Add `MarkdownShape` type to `materializer.ts` and export from barrel.
- [ ] **1.3** Rewrite `TableConfig<TRow>` to use the three new slots (`filename`, `toMarkdown`, `fromMarkdown`).
- [ ] **1.4** Update the default-replacement inside `materializeTable` to compose the three slots:
  ```ts
  const filenameFn = config.filename ?? ((row) => `${row.id}.md`);
  const toMarkdownFn = config.toMarkdown ?? ((row) => ({ frontmatter: row, body: undefined }));
  const filename = await filenameFn(row);
  const shape = await toMarkdownFn(row);
  const content = assembleMarkdown(shape.frontmatter, shape.body);
  ```
- [ ] **1.5** Rewrite the observer + `pull` paths with the same composition.
- [ ] **1.6** Rewrite `push` to use `fromMarkdown` slot with default `(parsed) => parsed.frontmatter as Row`.
- [ ] **1.7** Update module-level `defaultSerialize`/`defaultDeserialize` constants to match the new shape semantics (or delete them: the per-slot defaults inside `materializeTable` are simple enough).

### Phase 1b: Helpers

- [ ] **1.8** Rewrite `serializers.ts`:
  - Keep `slugFilename(field)` and `toIdFilename(row)` as filename helpers (already correct shape).
  - Replace the existing `bodyField(field)` (currently returns `SerializeResult`) with two new helpers: `fieldAsBody(field)` (for `toMarkdown` slot) and `bodyAsField(field)` (for `fromMarkdown` slot).
  - Both helpers must be generic over `TRow extends BaseRow` so the field name is type-checked.

### Phase 2: Migrate call sites

- [ ] **2.1** Update `playground/opensidian-e2e/epicenter.config.ts`: split the 35-line `serialize` into `filename` + `format` + `parse`. This should dramatically shrink the config.
- [ ] **2.2** Update materializer test helpers that customize `serialize`/`deserialize`: `uses custom serialize callback` and `uses custom deserialize callback` tests.

### Phase 3: Type-level round-trip test

- [ ] **3.1** Add a test utility that asserts `parse(format(row)) ≡ row` for a given table.
- [ ] **3.2** Add at least one test using it on the opensidian `files` table.

### Phase 4: Documentation

- [ ] **4.1** Update the materializer JSDoc with the new slot semantics.
- [ ] **4.2** Update the attach-primitive skill: the materializer example currently shows the bundled `serialize`.
- [ ] **4.3** Add a short migration note (even though we're not keeping aliases, a CHANGELOG entry helps).

## Edge Cases

### Caller provides only `filename`, no `format`

1. `format` falls back to default: `frontmatter = row`, `body = undefined`.
2. Output: filename chosen by caller; frontmatter = full row dump.
3. Works.

### Caller provides `parse` but not `format`

1. Push path uses caller's `parse`.
2. Pull path uses default `format`: which may not produce what `parse` expects to invert.
3. Round-trip is broken by caller. **Accept this**: we can't enforce inverse relationship at runtime.

### `format` returns `body: undefined`

1. `toMarkdown` writes frontmatter-only, no body section.
2. `parseMarkdownFile` on read returns `body: undefined` (or `''`: TBD, this is an open question).
3. `parse` default treats frontmatter as row.

### Filename function returns a path with subdirectories

1. `filename(row)` returns `"archive/old.md"`.
2. `join(directory, filename)` resolves to `directory/archive/old.md`.
3. Materializer's `mkdir` only created the top-level directory: write fails.
4. **Handling**: ensure `mkdir` runs on `join(directory, dirname(filename))` per write. Minor but necessary.

## Open Questions

1. **Should `parse` return type be validated against the schema at runtime?**
   - Options: (a) no: trust the caller (current behavior); (b) yes: run the result through `table.parse()` and throw on invalid.
   - **Recommendation**: (a). The materializer never validates rows today; adding it here is scope creep. If callers want validation, they can compose.

2. **Should we keep `deserialize`/`serialize` as deprecated aliases for one release cycle?**
   - Options: (a) no: one commit, break cleanly; (b) yes: both work, deprecation warning.
   - **Recommendation**: (a). Two call sites in the entire repo; aliases would cost more than the migration does. No external users.

3. **Is there a case where `filename` depends on the markdown shape (frontmatter/body) rather than the row?**
   - E.g., filename from `frontmatter.slug` after format transforms it.
   - **Recommendation**: Start without it. If it surfaces, we can overload `filename` to accept either `row` or `shape`.

4. **Should we rename `body` to `content` to match gray-matter?**
   - `body` is the current term; gray-matter uses `content`.
   - **Recommendation**: Keep `body`. It's already in place and "content" collides with our own workspace `content` semantics (per-row docs).

## Success Criteria

- [ ] `TableConfig<TRow>` has three slots: `filename`, `toMarkdown`, `fromMarkdown`. `serialize` / `deserialize` are gone.
- [ ] Internal helper renamed from `toMarkdown(fm, body)` to `assembleMarkdown(fm, body)`.
- [ ] Two new independent helpers in `serializers.ts`: `fieldAsBody` and `bodyAsField`. Each returns one callable for one slot. No bundled pair.
- [ ] Default behavior matches current: `{row.id}.md` filename, row-as-frontmatter, frontmatter-as-row.
- [ ] Opensidian playground's markdown config is <25 lines of per-table logic (down from 35).
- [ ] A test verifies `fromMarkdown(toMarkdown(row)) ≡ row` for at least one table.
- [ ] All 72 materializer tests still pass.
- [ ] `.agents/skills/attach-primitive/SKILL.md` example shows the new slot shape.

## References

- `packages/workspace/src/document/materializer/markdown/materializer.ts`: primary rewrite target.
- `packages/workspace/src/document/materializer/markdown/markdown.ts`: `toMarkdown` helper we'll lean on.
- `packages/workspace/src/document/materializer/markdown/parse-markdown-file.ts`: already returns `{ frontmatter, body }`.
- `playground/opensidian-e2e/epicenter.config.ts:115-149`: largest call site; good test case for whether the split actually simplifies.
- `packages/workspace/src/document/materializer/markdown/materializer.test.ts`: migration target for tests.
- gray-matter's API for the naming model: https://github.com/jonschlinkert/gray-matter
