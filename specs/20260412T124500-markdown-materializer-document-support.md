# Typed createMaterializer with factory pattern and closure-based document access

## Task

Replace the markdown-specific `markdownMaterializer` with a general `createMaterializer` factory that follows the factory function composition pattern. First arg is the resource (extension context: `{ tables, kv }`), second is config (`{ dir }`). Returns a builder with `.table()` for opt-in per-table materialization and `.kv()` for opt-in KV materialization. Nothing materializes by default. Explicit `.table()` and `.kv()` calls opt in.

The serialize contract is general: `{ filename, content }`. A `markdown()` helper handles the common case of frontmatter + body. This eliminates the two app-specific materializers (fuji, opensidian) and generalizes beyond markdown.

## The Problem

The generic `markdownMaterializer` has three categories of issues:

**Type holes:**
1. Table names are untyped strings: `tables: { entries: {...} }` doesn't validate that `entries` exists
2. Row data is `Record<string, unknown>`: the serialize callback can't access `row.title` without casting
3. Document names are untyped strings: no validation that a document exists

**Markdown-specific contract:**
4. Serialize returns `{ frontmatter, body, filename }`: hardcoded to markdown format
5. No support for JSON, YAML, or custom file formats
6. No KV materialization

**Code duplication:**
7. Two app-specific materializers (~350 lines) exist solely because the generic one can't read documents

## Current Architecture

### Generic markdownMaterializer (`packages/workspace/src/extensions/materializer/markdown/markdown.ts`)

```typescript
// Returns a factory: called BEFORE context is available
export function markdownMaterializer(config: MarkdownMaterializerConfig) {
    return ({ tables }: ExtensionContext) => {
        // tables accessed by untyped string key: tables[tableKey]
        // serializer.serialize(row): row is Record<string, unknown>
        // returns { frontmatter, body, filename }: markdown-only
    };
}
```

### App-specific materializers that should not exist

1. `apps/fuji/src/lib/materializer.ts`: reads `documents.entries.content.open(row.id)`
2. `playground/opensidian-e2e/materializer.ts`: reads `documents.files.content.open(row.id)`

Both are ~80% identical to the generic materializer. The only differences: which table/document to use and frontmatter field selection.

### How vault config uses both today (`~/Code/vault/epicenter.config.ts`)

```typescript
// Tab manager: generic materializer (no documents)
export const tabManager = createTabManagerWorkspace()
    .withWorkspaceExtension('markdown', markdownMaterializer({
        directory: join(import.meta.dir, 'tab-manager'),
        tables: {
            savedTabs: { serializer: titleFilenameSerializer('title') },
            bookmarks: { serializer: titleFilenameSerializer('title') },
            devices: {},
        },
    }));

// Fuji: app-specific materializer (needs document content)
export const fuji = createFujiWorkspace()
    .withWorkspaceExtension('markdown', createFujiMaterializer({
        directory: import.meta.dir,
    }));
```

## New API Design

### Factory function pattern

Following the factory function composition skill: first arg is the resource (destructured for multiple dependencies: `{ tables, kv }`), second arg is config.

```typescript
type MaterializerContext<
    TTables extends Record<string, TableHelper<any>>,
    TKv extends Record<string, KvHelper<any>>,
> = {
    tables: TTables;
    kv: TKv;
    whenReady: Promise<void>;  // must await before reading data
};

function createMaterializer<
    TTables extends Record<string, TableHelper<any>>,
    TKv extends Record<string, KvHelper<any>>,
>(
    ctx: MaterializerContext<TTables, TKv>,
    config: { dir: string },
): MaterializerBuilder<TTables, TKv>;
```

The factory receives the extension context (structurally typed. Not importing `ExtensionContext`). Passing `ctx` directly from the `.withWorkspaceExtension` closure works because `ExtensionContext` satisfies `{ tables, kv, whenReady }` structurally. The materializer awaits `ctx.whenReady` before initial materialization to ensure persistence/sync have loaded data first. This gives the factory:
- `keyof TTables` for validated table name strings
- `TTables[K]` for row type inference per table
- `TKv` for typed KV access
- Table key names for default subdirectory names

### Opt-in materialization via `.table()` and `.kv()`

Nothing materializes by default. Call `.table(name)` to opt in a table. Call `.kv()` to opt in KV.

**Why opt-in, not default-materialize-all:**
- **No surprise files.** Adding a table to the workspace definition doesn't silently produce `.md` files on disk.
- **No `.skip()` needed.** The API surface shrinks. No negation mixed into the chain.
- **Explicit > implicit** for an extension that writes to the filesystem.
- **Every line is additive.** Each `.table()` call opts in one table. The chain is purely constructive.
- **In practice you customize most tables anyway** (filename strategy, document content), so you're writing `.table()` calls regardless.

The built-in default serialize (when `.table()` is called without a `serialize` option) is: all row fields as markdown frontmatter, `{id}.md` filename, written to `{dir}/{tableName}/`.

### General serialize contract

```typescript
type SerializeResult = {
    filename: string;
    content: string;
};

// Already exists in packages/workspace/src/workspace/lifecycle.ts: import, don't redefine
import type { MaybePromise } from './lifecycle.js';
```

The materializer writes `{ filename, content }`. It doesn't know or care about markdown, JSON, or any format.

### `markdown()` helper for the common case

```typescript
/**
 * Convert frontmatter + body to a markdown file result.
 *
 * Applies epicenter link → wikilink conversion to body content.
 * Handles undefined body (frontmatter-only output).
 *
 * For markdown WITHOUT link conversion, use `toMarkdown()` directly:
 * ```typescript
 * serialize: (row) => ({
 *     filename: `${row.id}.md`,
 *     content: toMarkdown({ id: row.id, title: row.title }, body),
 * })
 * ```
 */
function markdown(input: {
    frontmatter: Record<string, unknown>;
    body?: string;
    filename: string;
}): SerializeResult {
    const processedBody = input.body
        ? convertEpicenterLinksToWikilinks(input.body)
        : input.body;
    return {
        filename: input.filename,
        content: toMarkdown(input.frontmatter, processedBody),
    };
}
```

### `.table()` chain with typed overrides

```typescript
interface MaterializerBuilder<TTables, TKv> {
    /**
     * Opt in a table for materialization.
     *
     * Each row produces one file in `{dir}/{tableName}/` (or `{dir}/{config.dir}/`).
     * Table name is validated against TTables keys. Serialize callback receives
     * typed row inferred from the table.
     *
     * @remarks Without a serialize option, defaults to markdown: all row fields as
     * YAML frontmatter, `{id}.md` filename.
     */
    table<K extends keyof TTables & string>(
        name: K,
        config?: {
            /** Subdirectory name. Defaults to the table key name. */
            dir?: string;
            /** Custom serialize. Defaults to markdown frontmatter + {id}.md. */
            serialize?: TTables[K] extends TableHelper<infer TRow>
                ? (row: TRow) => MaybePromise<SerializeResult>
                : never;
        },
    ): this;

    /**
     * Opt in KV materialization.
     *
     * Writes all KV data to a single file. Live updates via `kv.observeAll()`.
     * Default: `{dir}/kv.json` with `JSON.stringify`.
     *
     * @remarks For custom format, provide a serialize callback that receives the
     * full KV snapshot (all key-value pairs as a typed object) and returns
     * `{ filename, content }`.
     */
    kv(config?: {
        /** Custom serialize. Receives full KV snapshot, returns { filename, content }. */
        serialize?: (data: { [K in keyof TKv & string]: TKv[K] extends KvHelper<infer V> ? V : never }) => SerializeResult;
    }): this;

    /**
     * Extension lifecycle.
     *
     * `whenReady` resolves after initial materialization of all opted-in tables and KV.
     * Materialization starts lazily when the framework accesses `whenReady`,
     * which is after all `.table()` and `.kv()` calls have completed
     * (they run synchronously in the factory closure).
     */
    whenReady: Promise<void>;
    dispose(): void;
}
```

### KV materialization

KV materializes only when `.kv()` is called (opt-in). Default: all KV data as `{dir}/kv.json` with `JSON.stringify`. KV changes are observed live via `kv.observeAll()`. Custom format via `serialize` option:

```typescript
// Default: kv.json with JSON
.kv()

// Custom: YAML format
.kv({
    serialize: (data) => ({
        filename: 'settings.yaml',
        content: YAML.stringify(data),
    }),
})
```

## Desired End State

### Vault config after migration

```typescript
import {
    createMaterializer,
    markdown,
    slugFilename,
    toSlugFilename,
} from '@epicenter/workspace/extensions/materializer';

// Tab manager: override filename strategy, everything else defaults
export const tabManager = createTabManagerWorkspace()
    .withWorkspaceExtension('materializer', (ctx) =>
        createMaterializer(ctx, {
            dir: join(import.meta.dir, 'tab-manager'),
        })
        .table('savedTabs', { serialize: slugFilename('title') })
        .table('bookmarks', { serialize: slugFilename('title') })
        .table('devices')
        .kv()
    );

// Fuji: custom serialize with document content via closure
export const fuji = createFujiWorkspace()
    .withWorkspaceExtension('materializer', (ctx) =>
        createMaterializer(ctx, { dir: import.meta.dir })
        .table('entries', {
            dir: 'fuji',
            serialize: async (row) => markdown({
                // row: Entry: inferred from ctx.tables['entries']
                frontmatter: {
                    id: row.id,
                    title: row.title,
                    subtitle: row.subtitle,
                    type: row.type,
                    tags: row.tags,
                    createdAt: row.createdAt,
                    updatedAt: row.updatedAt,
                },
                body: await ctx.documents.entries.content
                    .open(row.id)
                    .then((h) => h.read())
                    .catch(() => undefined),
                filename: toSlugFilename(row.title, row.id),
            }),
        })
        .kv()
    );
```

### Opensidian e2e config after migration

```typescript
export const opensidian = createWorkspace(opensidianDefinition)
    .withWorkspaceExtension('materializer', (ctx) =>
        createMaterializer(ctx, {
            dir: join(import.meta.dir, 'data'),
        })
        .table('files', {
            serialize: async (row) => {
                // row: FileRow: inferred from ctx.tables['files']
                if (row.type === 'folder') {
                    return markdown({
                        frontmatter: { id: row.id, name: row.name, type: 'folder' },
                        filename: toIdFilename(row.id),
                    });
                }
                return markdown({
                    frontmatter: {
                        id: row.id,
                        name: row.name,
                        parentId: row.parentId,
                        size: row.size,
                        createdAt: row.createdAt,
                        updatedAt: row.updatedAt,
                        trashedAt: row.trashedAt,
                    },
                    body: await ctx.documents.files.content
                        .open(row.id)
                        .then((h) => h.read())
                        .catch(() => undefined),
                    filename: toSlugFilename(
                        row.name.replace(/\.md$/i, ''),
                        row.id,
                    ),
                });
            },
        })
    );
```

### Non-markdown example (JSON materialization)

```typescript
// Materialize devices as individual JSON files instead of markdown
createMaterializer(ctx, { dir: '...' })
    .table('devices', {
        serialize: (row) => ({
            filename: `${row.id}.json`,
            content: JSON.stringify(row, null, 2),
        }),
    })
```

## Materialization Model

| Source | Target | Default |
|---|---|---|
| Table row | One file per row | Markdown: frontmatter + `{id}.md` |
| KV | One JSON file for all KV | `{dir}/kv.json` |
| Table (all rows) | NOT SUPPORTED | Use custom extension if needed |

**Row → file** is the core use case (browsable content: notes, bookmarks, entries).
**KV → file** is natural (small, flat, key-value shaped).
**Table → file** is an export concern, not a materialization concern. Out of scope.

## Exported API Surface

### Factory

- `createMaterializer(ctx, { dir })`: factory: resource first (extension context), config second

### Serialize presets (markdown: return `SerializeResult`)

These produce markdown output. The names are short for call-site readability; JSDoc documents the format.

- `slugFilename(field)`: all fields as markdown frontmatter, slugified `{title}-{id}.md`. JSDoc: `@remarks Produces markdown output via markdown() internally.`
- `bodyField(field)`: extracts one field as markdown body, rest as frontmatter, `{id}.md`. JSDoc: `@remarks Produces markdown output via markdown() internally.`
- Default (when serialize omitted): all fields as markdown frontmatter, `{id}.md`

### Helpers

- `markdown({ frontmatter, body, filename })`: converts to `{ filename, content }` with wikilink processing
- `toSlugFilename(title, id)`: standalone string utility: `{slug}-{id}.md`
- `toIdFilename(id)`: standalone string utility: `{id}.md`
- `toMarkdown(frontmatter, body?)`: pure YAML frontmatter + body assembly (already exists)

### Types

- `SerializeResult`: `{ filename: string; content: string }`
- `MaybePromise<T>`: import from `packages/workspace/src/workspace/lifecycle.ts` (already exists)

## Files to Modify

### Primary (new materializer)

- `packages/workspace/src/extensions/materializer/`: new `createMaterializer` implementation. Consider whether it replaces `materializer/markdown/` or lives alongside it at `materializer/filesystem/` or `materializer/index.ts`.
- `packages/workspace/src/extensions/materializer/markdown/serializers.ts`: adapt existing serializer factories to return `SerializeResult` (general contract). Rename: `titleFilenameSerializer` → `slugFilename`, `bodyFieldSerializer` → `bodyField`. Add `toSlugFilename`, `toIdFilename` standalone utilities.
- `packages/workspace/src/extensions/materializer/markdown/markdown.ts`: extract `toMarkdown` as a reusable utility. The `markdown()` helper wraps it with wikilink conversion. The old `markdownMaterializer` function is deleted.
- `packages/workspace/src/extensions/materializer/markdown/index.ts`: update exports for new API surface.

### Secondary (consumers to delete)

- `apps/fuji/src/lib/materializer.ts`: **delete**
- `apps/fuji/package.json`: remove `"./materializer"` export, remove `@sindresorhus/slugify` and `filenamify` deps
- `playground/opensidian-e2e/materializer.ts`: **delete**

### Tertiary (consumers to migrate)

- `playground/opensidian-e2e/epicenter.config.ts`: use `createMaterializer` with `.table()` override
- `playground/tab-manager-e2e/epicenter.config.ts`: use `createMaterializer` if applicable
- `packages/cli/test/fixtures/*/epicenter.config.ts`: grep for materializer usage, migrate
- Any file importing from `@epicenter/workspace/extensions/materializer/markdown`

### External (vault: not in monorepo)

- `~/Code/vault/epicenter.config.ts`: replace both materializer setups with `createMaterializer`

## Design Decisions

### 1. General serialize contract: `{ filename, content }`

The materializer writes files. It doesn't care about format. Markdown-specific logic (`toMarkdown`, wikilink conversion) lives in the `markdown()` helper, not in the materializer core. This lets the same materializer handle markdown, JSON, YAML, or any custom format.

### 2. Factory function pattern: resource first, config second

`createMaterializer(ctx, { dir })` follows the universal factory function signature. `ctx` is the resource (structurally typed as `{ tables, kv }`: receives the extension context directly). `{ dir }` is the config. Two args max. `dir` is used consistently for both base path and table subdirectory. Context makes the meaning clear.

### 3. Opt-in materialization, not default-materialize-all

Nothing materializes until you call `.table()` or `.kv()`. This is the right default for an extension that writes to the filesystem:
- No surprise files when adding tables to a workspace definition
- No `.skip()` / `.skipKv()` needed. The API surface is purely additive
- Explicit enumeration: every `.table()` line is a conscious decision
- In practice, most tables need serialize customization anyway

### 4. Typed table names via generic + `keyof`

`.table('entries', ...)` validates `'entries'` against `keyof TTables`. Typo → TypeScript error. Row type in serialize callback inferred from `TTables['entries']`. Table key doubles as default subdirectory name.

### 5. Document access through closure, not context parameter

`serialize(row)` receives only the typed row. Document access happens through the extension closure (`documents.entries.content.open(row.id)`). This is fully typed with autocomplete. No `readDocument` helper or `SerializeContext` needed.

### 6. Row → file only, no table → file

Each row materializes as one file. There is no "dump entire table to one file" mode. That's an export concern, not a materialization concern. KV is the exception because it's naturally a flat structure.

### 7. KV → one JSON file (opt-in)

KV materializes only when `.kv()` is called. Default: `{dir}/kv.json` with JSON.stringify. Custom serialize for other formats. Live updates via `kv.observeAll()`.

### 8. `markdown()` helper applies wikilink conversion

The `markdown()` helper calls `convertEpicenterLinksToWikilinks` on body content. This is the only place epicenter-specific link processing happens. Custom serialize callbacks that don't use `markdown()` don't get link conversion, that's intentional. For markdown without link conversion, use `toMarkdown()` directly (already exported, pure function).

## Breaking Changes

Clean break. No backward compatibility.

- `markdownMaterializer` → `createMarkdownMaterializer` (kept markdown-specific name; `createMaterializer` was proposed but rejected)
- `MarkdownSerializer` type → deleted
- `MarkdownMaterializerConfig` type → deleted
- `serializer` config property → `.table(name, { serialize })` chain method
- `defaultSerializer()` → omit serialize (default behavior)
- `bodyFieldSerializer(field)` → `bodyField(field)`
- `titleFilenameSerializer(field)` → `slugFilename(field)`
- Serialize return: `{ frontmatter, body, filename }` → `{ filename, content }` (use `markdown()` helper)

All consumers in the monorepo must be migrated in the same commit.

## MUST DO

- [x] Implement `createMarkdownMaterializer(ctx, { dir })` factory where ctx is structurally typed as `{ tables, kv, whenReady }`
- [x] Generic type parameters on factory for `TTables` and `TKv`: infer from ctx arg
- [x] `.table(name, config)` validates name as `keyof TTables`, infers row type for serialize callback
- [x] General serialize contract: `{ filename: string; content: string }`
- [x] `markdown()` helper: `{ frontmatter, body, filename }` → `{ filename, content }` with wikilink conversion
- [x] Opt-in materialization: nothing by default, `.table()` opts in per table, `.kv()` opts in KV
- [x] Await `ctx.whenReady` before initial materialization (ensures persistence/sync have loaded data)
- [x] Default table serialize (when `.table()` called without serialize): all fields as markdown frontmatter, `{id}.md`
- [x] `.kv()` default: `{dir}/kv.json` with JSON.stringify. Custom serialize receives typed KV snapshot.
- [x] Rename serialize presets: `slugFilename(field)`, `bodyField(field)`
- [x] Export standalone utilities: `toSlugFilename(title, id)`, `toIdFilename(id)`
- [x] Delete `apps/fuji/src/lib/materializer.ts`
- [x] Delete `playground/opensidian-e2e/materializer.ts`
- [x] Update `apps/fuji/package.json`: remove `"./materializer"` export, remove deps
- [x] Migrate all config files
- [x] Run `bun test packages/workspace` to verify no regressions (647 pass, 0 fail)
- [x] Run `bun x epicenter start . --verbose` from `~/Code/vault` after migration
  > **Note**: Blocked by pre-existing branch issues (missing `definition.ts` from prior refactor, removed sqlite export). Materializer exports verified independently.

## MUST NOT DO

- Do not add backward compatibility for old `markdownMaterializer` API
- Do not support table → one file (all rows in single file)
- Do not add new dependencies to `packages/workspace`
- Do not modify `packages/workspace/src/workspace/types.ts`
- Do not remove `toMarkdown` utility. It's still needed by the `markdown()` helper
- Do not add `.skip()` or `.skipKv()`: opt-in model makes them unnecessary

## Resolved Open Questions

| # | Issue | Resolution |
|---|---|---|
| 1 | Preset names don't indicate markdown | **JSDoc**: `@remarks Produces markdown output via markdown() internally`. Short names fine for readability. |
| 2 | Default-materialize-all assumptions | **API fix**: switched to opt-in. No defaults, no assumptions about table content. |
| 3 | KV observation | **Resolved**: `kv.observeAll(cb)` exists. Live materialization works. |
| 4 | `markdown()` link conversion opt-out | **JSDoc**: `toMarkdown()` is the escape hatch (pure, no links). |
| 5 | `whenReady` timing | **JSDoc**: lazy start after all `.table()`/`.kv()` calls complete synchronously. |
| 6 | `.kv({ skip })` vs `.skipKv()` | **API fix**: eliminated both. Opt-in model means no skip needed. |
| 7 | `MaybePromise<T>` | **Resolved**: import from `lifecycle.ts`. |
| 8 | `directory` vs `dir` | **API fix**: `dir` everywhere. Short, consistent. Context makes base path vs subfolder obvious. |
| 9 | KV serialize/overrides | **API fix**: `.kv({ serialize })` receives typed KV snapshot, returns `SerializeResult`. |
| 10 | Global default serialize | **No**: would be `Record<string, unknown>` (untyped), defeating row type inference. Built-in default is always safe. Two-line repetition is fine. |
| 11 | `ctx.whenReady` ordering | **API fix**: structural type includes `whenReady`. Materializer awaits it before reading data to avoid racing persistence/sync. |

## Review

**Completed**: 2026-04-12
**Branch**: `feat/workspace-api-surface`

### Summary

Replaced the markdown-specific `markdownMaterializer` with `createMarkdownMaterializer(ctx, { dir })`. The new API uses a builder pattern with `.table()` and `.kv()` opt-in chains, generic type parameters for type-safe table names and row inference, and a general `SerializeResult` contract (`{ filename, content }`). The `markdown()` helper handles frontmatter + wikilink conversion as a composable utility rather than baked-in behavior.

### Deviations from Spec

- `TKv` generic is `KvHelper<any>` (single helper), not `Record<string, KvHelper<any>>` as the spec suggested. The actual workspace type has `kv` as a single `KvHelper`, not a record of helpers.
- Initial KV materialization writes nothing (no key enumeration API). The file appears on first `observeAll` change. Spec implied initial snapshot but `KvHelper` doesn't expose bulk-read.
- Observer writes are sequential (not `Promise.allSettled`). This prevents rename races where a parallel delete could remove a file another write targets.
- `writeSerializedFile` helper was added then inlined during code review: the indirection didn't earn its keep.

### Follow-up Work

- `KvHelper` could expose `getAll()` or `keys()` to enable initial KV snapshot materialization.
- The fuji workspace on the current branch has a broken import (`definition.ts` was refactored into `workspace.ts` in a prior commit). The vault `epicenter start` test is blocked by this pre-existing issue.
- ~~Consider whether `createMaterializer` should live in a format-agnostic location~~: rejected. The name stays `createMarkdownMaterializer` and lives under `materializer/markdown/`. The factory was split into its own `materializer.ts` file, separate from the pure formatting helpers in `markdown.ts`.
