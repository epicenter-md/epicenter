# Fuji Bulk Add Modal

Paste timestamped text, pick a timezone, and bulk-insert entries into Fuji.

## Input Format

Each line of the textarea follows:

```
<ISO 8601 UTC timestamp><space><text>
```

Example:

```
2026-04-08T12:39:54.844Z One of the craziest life hacks I've seen...
2026-04-08T13:01:22.000Z Another thought about tea kettles...
```

## Parsing

1. Split textarea value by `\n`, filter out blank lines.
2. For each line, match `^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\s(.+)$`.
3. Group 1 = ISO UTC string, Group 2 = entry text.
4. Lines that don't match the pattern are skipped (show count of skipped lines in preview).

## Entry Construction

For each parsed line:

```ts
{
  id: generateId() as unknown as EntryId,
  title: text,           // full text from the line
  subtitle: '',
  type: [],
  tags: [],
  pinned: false,
  deletedAt: undefined,
  date: DateTimeString.stringify(isoUtc, selectedTimezone),
  createdAt: DateTimeString.now(),
  updatedAt: DateTimeString.now(),
  _v: 1 as const,
}
```

## Submit

Call `await workspace.tables.entries.bulkSet(rows)`. Close modal on success. Show toast with count.

## Component

`BulkAddModal.svelte`: self-contained with its own trigger button.

Uses `Modal` (not Dialog) per UI README: "If the user needs to type or input data, use Modal."

### Structure

```
Modal.Root (bind:open)
  trigger button (clipboard-paste icon in AppHeader)
  Modal.Content
    Modal.Header
      Modal.Title: "Bulk Add Entries"
      Modal.Description: "Paste timestamped lines..."
    <form>
      Textarea (paste area, bind:value)
      TimezoneCombobox (bind:value, reuse existing component)
      Preview line: "{n} entries parsed, {m} skipped"
    </form>
    Modal.Footer
      Cancel button
      Add {n} entries button (disabled when n=0)
```

### Timezone

Reuse `TimezoneCombobox` from `@epicenter/ui/timezone-combobox`. Default to `localTimezone()` from `@epicenter/ui/natural-language-date-input`.

## Files Changed

| File | Change |
|------|--------|
| `apps/fuji/src/lib/components/BulkAddModal.svelte` | New file. The modal component |
| `apps/fuji/src/lib/components/AppHeader.svelte` | Add trigger button next to existing "+" button |

The modal is self-contained (trigger + content in one component, like `NewSkillDialog.svelte` in apps/skills). AppHeader just renders `<BulkAddModal />`.

## Todo

- [ ] Create `BulkAddModal.svelte` with Modal, Textarea, TimezoneCombobox, parsing logic, and bulkSet call
- [ ] Add `<BulkAddModal />` to `AppHeader.svelte` next to the existing new-entry button
- [ ] LSP diagnostics clean on both files
