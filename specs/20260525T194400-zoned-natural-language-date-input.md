# Zoned Natural-Language Datetime Input

**Date**: 2026-05-25
**Status**: Draft
**Author**: AI-assisted (claude@bradenwong.com)
**Branch**: braden-w/typebox-table-kv-spec

## Overview

Fix the implicit-zone bug in Fuji's entry date picker by introducing two-layer composition under `packages/ui/src/natural-language-date-input/`:

1. The existing `NaturalLanguageDateInput` (shadcn-style primitive) gains a `timeZone?: IanaTimeZone` prop. Parsing happens in that zone, not the runtime's local zone. Public surface stays one prop wider than upstream.
2. A new `ZonedNaturalLanguageDateInput` composes the primitive with `TimezoneCombobox`. It owns the zone draft internally, takes one seed prop (`initialDateZone`), and emits a single atomic `onChoice({ label, date, dateZone })` event.

Fuji's `EntryEditor` swaps two children + one `$state` line for one wrapper. The bug where a non-local zone selection produced a UTC instant tied to the runtime's local wall-clock becomes structurally impossible.

## Motivation

`apps/fuji/src/routes/(signed-in)/components/EntryEditor.svelte:146-156` today:

```svelte
<NaturalLanguageDateInput
  onChoice={({ date }) => {
    updateEntry({
      date: date.toISOString() as DateTimeString,
      dateZone: dateTz,
    });
    isDatePopoverOpen = false;
  }}
/>
<TimezoneCombobox bind:value={dateTz} />
```

The primitive calls `chrono.parse(value, new Date())` with no `timezone` reference, so "5pm" resolves to 5pm in `Intl.DateTimeFormat().resolvedOptions().timeZone`. If `dateTz` is `Asia/Tokyo` but the runtime is in `America/Los_Angeles`, the stored pair is `(date = 5pm-PT-as-UTC, dateZone = Asia/Tokyo)`. Reading it back as 5pm Tokyo is wrong by the LA-Tokyo offset.

## Design Decisions

### Two components, one new file

```
packages/ui/src/natural-language-date-input/
  natural-language-date-input.svelte        # modified
  zoned-natural-language-date-input.svelte  # new
  parse.ts                                  # new (pure helper)
  index.ts                                  # adds wrapper export
```

The primitive stays a thin shadcn-style cell. Callers who already have a zone context (e.g. a calendar grid pinned to one zone) use the primitive directly. Callers who need user-selectable zone use the wrapper.

### Primitive surface

```ts
export type NaturalLanguageDateInputProps = {
  timeZone?: IanaTimeZone;          // defaults to IanaTimeZone.current()
  min?: Date;
  max?: Date;
  placeholder?: string;
  onChoice?: (choice: { label: string; date: Date }) => void;
};
```

- Emits `Date` (UTC instant). The `DateTimeString` brand belongs at the workspace boundary; the primitive doesn't import workspace types except for `IanaTimeZone` (a brand-only type-import).
- `min`/`max` are UTC instants. Wall-clock constraints are a future concern; no consumer needs them today.
- No typed-zone parsing ("tomorrow 5pm Tokyo"). Explicit UI is the contract.

### Wrapper surface

```ts
export type ZonedDateTimeChoice = {
  label: string;
  date: DateTimeString;
  dateZone: IanaTimeZone;
};

export type ZonedNaturalLanguageDateInputProps = {
  /** Seed zone. Component owns the draft. Not reactive after mount. */
  initialDateZone?: IanaTimeZone;
  min?: Date;
  max?: Date;
  placeholder?: string;
  onChoice: (choice: ZonedDateTimeChoice) => void;
};
```

Three deliberate choices, grounded in Svelte 5 docs (see DeepWiki query in the design conversation):

1. **No `date` prop.** The date has no draft state. The text input never displays the entry's existing date. `onChoice` is the only output channel.
2. **No `bind:dateZone`.** Uncontrolled-mode pattern: the wrapper owns its own zone state seeded from `initialDateZone`. Fuji has no use for the draft zone outside the popover. Adding `bind:dateZone` later is non-breaking (controlled-mode opt-in).
3. **Single `onChoice` carries both fields.** Atomic commit. The parent never has to read the zone separately; it arrives in the same payload as the date.

This avoids the Svelte 5 anti-pattern of exposing both `$bindable` and a callback that emits the same data.

### Pure parser

```ts
// packages/ui/src/natural-language-date-input/parse.ts

export type ParsedSuggestion = { label: string; date: Date };

export type ParseInZoneOptions = {
  text: string;
  referenceNow: Date;
  timeZone: IanaTimeZone;
  min?: Date;
  max?: Date;
};

export function parseInZone(opts: ParseInZoneOptions): ParsedSuggestion[];
```

Implementation: compute the offset (positive minutes east of UTC) of `timeZone` at `referenceNow` via `Intl.DateTimeFormat` `longOffset` parts. Pass it to `chrono.parse(text, { instant: referenceNow, timezone: offsetMinutes })`. chrono uses that offset as the reference timezone when resolving bare wall-clock phrases. Filter by `min`/`max` (strict `>` / `<`, matching current behavior).

DST edge: the offset is computed *at the reference instant*. A phrase like "tomorrow at 2:30am" parsed the day before spring-forward uses today's offset; that's chrono's behavior, not ours to override. Document the limitation in a comment.

### Fuji migration

```svelte
<ZonedNaturalLanguageDateInput
  initialDateZone={entry.dateZone}
  onChoice={({ date, dateZone }) => {
    updateEntry({ date, dateZone });
    isDatePopoverOpen = false;
  }}
/>
```

Deletes:
- `let dateTz = $state(entry.dateZone)` line.
- `TimezoneCombobox` import.
- The sibling `<TimezoneCombobox bind:value={dateTz} />` markup.

## Implementation Waves

### Wave A: pure helper + types

Add `packages/ui/src/natural-language-date-input/parse.ts` exporting `parseInZone`, `ParsedSuggestion`, `ParseInZoneOptions`. Type-only import of `IanaTimeZone` from `@epicenter/workspace`.

### Wave B: primitive update

Modify `natural-language-date-input.svelte`:
- Add `timeZone?: IanaTimeZone` to the prop type.
- Replace the inline `$derived` chrono parse with `parseInZone({ text: value, referenceNow: new Date(), timeZone, min, max })`.
- Default `timeZone` to `IanaTimeZone.current()`.

### Wave C: wrapper component

Add `zoned-natural-language-date-input.svelte` with the prop shape above. Internally: one `$state(initialDateZone ?? IanaTimeZone.current())` for the draft zone, one child `<NaturalLanguageDateInput timeZone={dateZone} ...>`, one child `<TimezoneCombobox bind:value={dateZone} />`.

### Wave D: exports

`index.ts` re-exports `ZonedNaturalLanguageDateInput` + `ZonedNaturalLanguageDateInputProps` + `ZonedDateTimeChoice`.

### Wave E: Fuji migration

Edit `apps/fuji/src/routes/(signed-in)/components/EntryEditor.svelte` per the diff above.

### Wave F: typecheck + review

`bun run --filter @epicenter/ui typecheck` and the Fuji equivalent. Post-implementation review pass per `AGENTS.md`.

## Edge Cases & Tests

Tests live next to the helper: `packages/ui/src/natural-language-date-input/parse.test.ts`.

- "tomorrow at 5pm" with `timeZone = America/Los_Angeles`, `referenceNow = 2026-05-25T17:00:00Z` → `date = 2026-05-26T00:00:00Z` (midnight UTC = 5pm PDT).
- Same input with `timeZone = America/New_York` → `date = 2026-05-25T21:00:00Z`.
- "in 2 hours" must be unaffected by `timeZone` (relative phrase).
- `min` filter: a suggestion equal to `min` is filtered out (matches existing `>` semantics).
- Empty input → `[]`, no chrono call.
- "noon" with `timeZone = Asia/Tokyo` at the right reference produces a UTC instant 9 hours before local noon Tokyo.
- A suggestion outside `[min, max]` filtered out cleanly.

Non-tested but documented:
- DST gap interpretation defers to chrono.
- Typed timezone names in input are not supported.

## Out of Scope

- `bind:dateZone` (controlled mode). Add when a concrete consumer needs it.
- `bind:date` ever. Date has no draft state.
- `wallClockMin` / `wallClockMax`. No consumer.
- `source: "selected-zone" | "typed-zone"` discriminator. No second source.
- Migrating `chrono-node` away. The library is already a dependency; the helper is pure and swappable later.
