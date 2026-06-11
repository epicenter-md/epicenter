# Reddit Ingest Hardening

**Date**: 2026-03-11
**Status**: Draft
**Author**: AI-assisted

## Overview

The Reddit GDPR ingest pipeline in `packages/workspace/src/ingest/reddit/` is architecturally solid but has three bugs that cause silent data loss or total import failure on real-world exports. This spec fixes those bugs and addresses three minor issues found during audit.

## Motivation

### Current State

The ingest pipeline works correctly on small, well-formed exports:

```typescript
const workspace = createWorkspace(redditWorkspace);
const stats = await importRedditExport(zipFile, workspace);
// ✅ Works for typical accounts
```

This breaks in three ways for real-world data:

1. **Batched files are invisible.** Reddit splits large CSVs (`post_votes_1.csv`, `post_votes_2.csv`) when they exceed ~100K rows. The parser looks for exactly `post_votes.csv` and silently returns zero rows for the split files. A power user with 200K upvotes imports zero votes with no warning.

2. **One bad row kills everything.** `schema.assert()` throws on validation failure. It's called inside `.map()` with no try/catch. A single malformed row in a 50K-row CSV aborts the entire import. All 24 tables, the whole `workspace.batch()` transaction.

3. **BOM corrupts the first column.** UTF-8 BOM (`\xEF\xBB\xBF`) prefixed to the first CSV file makes the first header column `\xEF\xBB\xBFid` instead of `id`. Every row gets a missing `id` field, schema validation fails, and issue #2 cascades.

### Desired State

```typescript
const stats = await importRedditExport(zipFile, workspace);
// stats.tables = { posts: 342, comments: 1205, postVotes: 187432, ... }
// stats.errors = [{ table: 'comments', row: 4891, error: 'invalid date' }]
// stats.skipped = 3
// stats.totalRows = 52341
```

The import succeeds even when individual rows are malformed, reports what failed, and captures all data from batched files.

## Research Findings

### Batched File Format

Reddit splits CSVs when they grow too large. The naming pattern is `{name}_{n}.csv` where `n` starts at 1:

```
reddit-export.zip
├── post_votes.csv          ← Small account: single file
├── post_votes_1.csv        ← Large account: split into parts
├── post_votes_2.csv
├── post_votes_3.csv
├── comments.csv            ← Most files aren't split
└── ...
```

The threshold is approximately 100K rows or 50MB per file. Any CSV in the export can theoretically be split, though in practice only high-volume files (votes, comments, posts) hit this.

**Key finding**: When split files exist, the unsplit version (`post_votes.csv`) does NOT exist. It's one or the other, never both.

**Implication**: The parser must match `{name}.csv` OR `{name}_*.csv` and concatenate all matches.

### Arktype Validation Modes

Arktype offers two invocation styles:

```typescript
// Throws on failure (current approach)
const row = schema.assert(rawRow);

// Returns union (what we want)
const result = schema(rawRow);
if (result instanceof type.errors) {
  // Handle gracefully
} else {
  // Use valid row
}
```

`schema()` (call syntax) returns the validated value on success or a `type.errors` instance on failure. No try/catch needed.

**Implication**: Switch from `.assert()` to call syntax for per-row error recovery.

### UTF-8 BOM in CSV Files

Reddit exports are UTF-8. Some CSV generators prepend a BOM (`U+FEFF`, encoded as `\xEF\xBB\xBF`). The `TextDecoder` with default options does not strip it. The CSV parser then includes it in the first header character.

**Key finding**: Only the very first file's first byte matters. BOM mid-file is not an issue.

**Implication**: Strip BOM once after decoding, before CSV parsing. One line.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Batched file matching | Glob-style: collect all `{name}*.csv` and `{name}_*.csv` entries | Handles both split and unsplit formats without knowing the threshold |
| Row-level error recovery | `schema()` call syntax, skip bad rows, collect errors | One bad row shouldn't poison 50K good ones |
| Error reporting | Add `errors` and `skipped` fields to `ImportStats` | Caller needs to know what failed and why |
| BOM stripping | Strip in `parse.ts` after `TextDecoder`, before CSV | Single location, catches all files |
| Composite ID separator | Change `:` to `\|` (pipe) | URLs contain colons; pipes are safer and equally readable |
| README excluded count | Fix from "16" to "14" | Matches the actual list |

## Architecture

The pipeline stays the same. Changes are localized:

```
parse.ts        → Fix: batched file matching + BOM stripping
csv-schemas.ts  → Fix: change composite ID separator from ':' to '|'
index.ts        → Fix: schema() instead of schema.assert(), error collection
README.md       → Fix: excluded file count
```

```
BEFORE:                                    AFTER:
─────────                                  ──────

parse.ts:                                  parse.ts:
  find(name === csvFile)                     findAll(name matches csvFile pattern)
  → single file or nothing                   → concatenate all matching files
                                             + strip BOM after decode

index.ts:                                  index.ts:
  csvData.map(schema.assert)                 csvData per row:
  → throws on first bad row                    result = schema(row)
  → entire import lost                         if error → collect, skip
                                               if valid → insert
                                             → import continues
```

## Implementation Plan

### Phase 1: Batched File Support (parse.ts)

- [ ] **1.1** Replace `.find()` with a function that collects ALL matching ZIP entries for a given CSV name. Match both `{name}.csv` and `{name}_{n}.csv` patterns (and their subdirectory variants `*/{name}.csv`, `*/{name}_{n}.csv`).
- [ ] **1.2** Concatenate matched CSV files. Each file has its own header row. Parse each independently with `CSV.parse()`, then merge the resulting row arrays. (Don't naive-concatenate raw text; headers would appear as data rows.)
- [ ] **1.3** Add BOM stripping after `TextDecoder().decode()`: `text.replace(/^\uFEFF/, '')`. Apply to every decoded CSV.

### Phase 2: Row-Level Error Recovery (index.ts)

- [ ] **2.1** Add error tracking types to `ImportStats`:
  ```typescript
  export type ImportError = {
    table: string;
    rowIndex: number;
    error: string;
  };

  export type ImportStats = {
    tables: Record<string, number>;
    kv: number;
    totalRows: number;
    errors: ImportError[];
    skipped: number;
  };
  ```
- [ ] **2.2** Rewrite `importTableRows` to use `schema()` call syntax instead of `schema.assert()`. On validation failure, push to errors array and continue. On success, call `tableClient.set()`.
- [ ] **2.3** Update `importRedditExport` to pass errors array through and return it in stats.

### Phase 3: Composite ID Separator (csv-schemas.ts)

- [ ] **3.1** Change `.join(':')` to `.join('|')` in the three composite ID schemas: `pollVotes`, `gildedContent`, `goldReceived`. This is a breaking change for existing data. If any workspace already has imported data with `:` IDs, re-importing will create duplicates rather than overwriting. Document this in the README.

### Phase 4: Documentation (README.md)

- [ ] **4.1** Fix the excluded files count from "16" to match the actual list (14).
- [ ] **4.2** Add a note about batched file support in the Architecture section.
- [ ] **4.3** Add a note that one bad row doesn't abort the import. Errors are collected and reported.

### Phase 5: Tests

- [ ] **5.1** Test batched file parsing: create a mock ZIP with `post_votes_1.csv` (3 rows) and `post_votes_2.csv` (2 rows). Verify 5 rows are imported.
- [ ] **5.2** Test BOM handling: create a CSV with BOM prefix, verify first column header is clean.
- [ ] **5.3** Test row-level error recovery: create a CSV with one good row, one malformed row, one good row. Verify 2 rows imported, 1 error reported.
- [ ] **5.4** Test that a completely missing CSV file still returns empty (regression).

## Edge Cases

### Batched Files With Inconsistent Headers

1. `post_votes_1.csv` has headers `id,permalink,direction`
2. `post_votes_2.csv` has headers `id,permalink,direction` (same)
3. Each file is parsed independently → headers are consumed per file → no issue

If Reddit ever changes column order between split files, the CSV parser handles it because it maps by header name, not position.

### Batched File Numbering Gaps

1. ZIP contains `comments_1.csv` and `comments_3.csv` (no `_2`)
2. The glob pattern collects both
3. Both are parsed and concatenated
4. No issue. We don't care about numbering continuity

### Unsplit File Coexists With Split Files

1. ZIP contains both `post_votes.csv` AND `post_votes_1.csv`
2. Research says this doesn't happen, but if it does: collect all matches, concatenate
3. Duplicate rows would be deduped by the workspace's upsert (same ID = overwrite)

### BOM in Non-First File

1. First CSV has no BOM, but `chat_history.csv` does
2. The BOM stripping runs on EVERY decoded file, not just the first
3. No issue

### All Rows in a Table Are Invalid

1. `payouts.csv` has 3 rows, all fail validation
2. `stats.tables.payouts = 0`, `stats.skipped += 3`, `stats.errors` has 3 entries
3. Import continues with other tables

### Re-Import After Composite ID Separator Change

1. User previously imported with `:` separator
2. Re-imports after the `|` change
3. Old rows (`:` IDs) remain, new rows (`|` IDs) are added as separate entries
4. This creates duplicates for `gildedContent`, `goldReceived`, and `pollVotes` only
5. **Mitigation**: Document in README. For existing users, recommend clearing those three tables before re-import. For new users, no action needed.

## Open Questions

1. **Should we stream ZIP decompression instead of loading it all into memory?**
   - Current approach: `unzipSync(bytes)` loads entire ZIP into memory
   - For most users (<50MB compressed) this is fine
   - For very large accounts (500MB+), memory could spike
   - **Recommendation**: Defer. The sync approach is simpler and works for the 99% case. Add streaming later if real users hit memory limits.

2. **Should `importRedditExport` return a `Result` type instead of throwing?**
   - Currently the function can still throw if the ZIP itself is invalid (not a validation error, but a structural error)
   - Row-level errors are now collected, but ZIP-level errors still throw
   - **Recommendation**: Wrap the top-level `parseRedditZip` call in try/catch and return a Result. But this is a separate concern from the three bugs being fixed here. Defer to a follow-up.

3. **Should error details include the raw row data for debugging?**
   - Pro: helps users understand what went wrong
   - Con: could include PII (the raw CSV row might have IP addresses, etc.)
   - **Recommendation**: Include only the row index and the validation error message, not the raw data.

## Success Criteria

- [ ] A ZIP with `post_votes_1.csv` + `post_votes_2.csv` imports all rows from both files
- [ ] A CSV with one malformed row among 100 good rows imports 100 rows and reports 1 error
- [ ] A CSV with UTF-8 BOM imports correctly with clean column headers
- [ ] Re-importing the same ZIP produces identical stats (idempotent)
- [ ] `ImportStats` includes `errors` array and `skipped` count
- [ ] Composite IDs use `|` separator
- [ ] README excluded file count is accurate
- [ ] All existing tests still pass
- [ ] `bun test` passes in `packages/workspace`

## References

- `packages/workspace/src/ingest/reddit/parse.ts`: ZIP parsing, file matching (Phase 1)
- `packages/workspace/src/ingest/reddit/csv-schemas.ts`: Arktype schemas, composite IDs (Phase 3)
- `packages/workspace/src/ingest/reddit/index.ts`: Import orchestration, error handling (Phase 2)
- `packages/workspace/src/ingest/reddit/README.md`: Documentation (Phase 4)
- `packages/workspace/src/ingest/utils/csv.ts`: CSV parser (no changes needed, but referenced for BOM context)
- `packages/workspace/src/ingest/reddit/workspace.ts`: Workspace definition (no changes needed)
- `packages/workspace/src/ingest/reddit/transforms.ts`: Transform utilities (no changes needed)
