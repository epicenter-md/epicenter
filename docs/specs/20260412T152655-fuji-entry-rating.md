# Fuji: Add Entry Rating (1-5 Stars)

## Goal

Add a `rating` field (0-5 integer) to Fuji entries so users can mark how memorable/impactful a piece of content is. Display as interactive stars in the editor and read-only stars in the table.

## Files to Change

| File | Change |
|---|---|
| `src/lib/workspace.ts` | Add `rating: 'number'` to entries schema, update create/update mutations, add `'rating'` to sortBy KV |
| `src/lib/entries.svelte.ts` | Widen `sortBy` type to include `'rating'` |
| `src/lib/components/EntryEditor.svelte` | Add star rating input in metadata section |
| `src/lib/components/EntriesTable.svelte` | Add rating column with read-only star display |
| `src/lib/components/StarRating.svelte` | New component: thin star rating using bits-ui RatingGroup |

## Todo

- [ ] Add star rating component (bits-ui RatingGroup wrapper, same pattern as shadcn-svelte-extras)
- [ ] Add `rating` field to entries table schema + create/update mutations in workspace.ts
- [ ] Add `'rating'` to sortBy KV type in workspace.ts and entries.svelte.ts
- [ ] Add star rating input to EntryEditor.svelte metadata section
- [ ] Add rating column to EntriesTable.svelte
- [ ] Verify with lsp_diagnostics

## Design Decisions

**Field name**: `rating`: matches Airtable's built-in field type, universally understood.

**Data type**: `'number'` (0-5 integer). 0 = unrated, 1-5 = user assessment. Default 0 on creation.

**Component**: Rather than installing jsrepo + shadcn-svelte-extras (new toolchain dependency for one component), create a minimal `StarRating.svelte` using bits-ui's `RatingGroup` directly. bits-ui is already installed. Same result, no new dependency.

**Sort**: Add `'rating'` as a sortBy option so entries can be ordered by rating in both table and timeline views.

**Bulk create**: Not adding rating to bulkCreate: bulk import is for title+date pairs, rating is a manual assessment.

## Review

_To be filled after implementation._
