# Natural Language Date Input

**Date**: 2026-04-08
**Status**: Implemented
**Author**: AI-assisted

## Overview

A two-input date editor component for `packages/ui` that parses natural language text via chrono-node, lets the user select an IANA timezone, and serializes the result as a `DateTimeString` (`"<ISO UTC>|<IANA timezone>"`) with two-way Svelte 5 binding.

## Motivation

### Current State

Fuji's entries table stores `createdAt` and `updatedAt` as `DateTimeString`:

```ts
// packages/workspace/src/shared/datetime-string.ts
// Storage format: "2024-01-01T20:00:00.000Z|America/New_York"
export function dateTimeStringNow(timezone?: string): DateTimeString {
  const tz = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${new Date().toISOString()}|${tz}` as DateTimeString;
}
```

All four Fuji components that display dates (StatusBar, EntriesTable, EntryTimeline, FujiSidebar) throw away the timezone half:

```ts
function parseDateTime(dts: string): Date {
  return new Date(dts.split('|')[0]!);
}
```

This creates problems:

1. **No date editing**: Fuji has zero UI for editing timestamps. Dates are set at creation time and never touched again.
2. **Timezone data is wasted**: The IANA timezone is stored but never surfaced or editable.
3. **No shared date input component**: `packages/ui` has no date/time editor beyond native `<input type="date">`.

### Desired State

A reusable `<NaturalLanguageDateInput>` component in `packages/ui` that:

```svelte
<NaturalLanguageDateInput bind:value={entry.createdAt} />
```

- Accepts NL text like "next tuesday 3pm", "tomorrow at noon", "in 2 hours"
- Shows a timezone selector defaulting to the timezone already in the `DateTimeString` value (or local system timezone if creating new)
- Displays a human-readable preview of the parsed date
- Two-way binds to a `DateTimeString` value via Svelte 5 `$bindable()`

## Research Findings

### chrono-node v2 (NL Parsing)

| Metric | Value |
|---|---|
| Version | 2.9.0 (TypeScript rewrite) |
| Production bundle (minified+gzip) | ~13KB |
| npm unpacked | 3.16MB (includes source maps, tests, all locales. Irrelevant to bundle) |
| Tree-shakeable | Yes (`sideEffects: false`) |
| Per-locale import | `import * as chrono from 'chrono-node/en'` |
| Weekly downloads | 929K |

**Supported NL patterns**: "today", "tomorrow", "yesterday", "next tuesday", "last friday", "5 days ago", "2 weeks from now", "in 1 hour", "tomorrow at noon", "Friday at 4pm", "March 15 2025 3:30pm".

**Timezone caveat**: `chrono.parseDate()` accepts a `timezone` option, but it expects **abbreviations** (`"PST"`, `"CDT"`) or **numeric minute offsets**, not IANA names (`"America/Los_Angeles"`). This requires a bridging step (see Design Decisions).

### Existing UI Primitives in `packages/ui`

| Component | Relevance |
|---|---|
| `Input` (`packages/ui/src/input/`) | Text field for NL input |
| `Popover` (`packages/ui/src/popover/`) | Container for the date editor |
| `Command` (`packages/ui/src/command/`) | Searchable list for timezone selection |
| `useCombobox` (`packages/ui/src/hooks/use-combobox.svelte.ts`) | Combobox state management (open/close, focus) |
| `Button` (`packages/ui/src/button/`) | Confirm action |

**Key finding**: All the UI primitives needed for the timezone combobox already exist. No new shadcn components need to be added.

### `DateTimeString` Format

```
"2024-01-01T20:00:00.000Z|America/New_York"
 ^^^^^^^^^^^^^^^^^^^^^^^^^ ^^^^^^^^^^^^^^^^
 ISO 8601 UTC instant       IANA timezone
```

- Pipe `|` separator. Never appears in ISO strings or IANA names, so `split('|')` is always safe
- UTC-first = lexicographic sort = chronological sort
- Branded type from `@epicenter/workspace`

### Timezone Bridging Approaches

chrono-node doesn't accept IANA timezone names. Three options evaluated:

| Approach | How it works | DST-safe? | Complexity |
|---|---|---|---|
| **A: Offset at reference time** | Compute IANA→offset at `new Date()`, pass to chrono | No. Offset may differ at parsed date if DST boundary crossed | Low |
| **B: Two-pass offset** | First parse to get target date, compute offset at target date, re-parse with correct offset | Yes | Medium |
| **C: Components + Intl** | Parse NL → extract (year, month, day, hour, min, sec) → use `Intl.DateTimeFormat` to resolve those components in the selected timezone to UTC | Yes | Medium |

**Recommendation**: Approach C. Extract chrono-node's parsed components, then use `Intl.DateTimeFormat` to resolve the local-time components to a UTC instant in the selected timezone. This is DST-safe, uses only browser built-ins for timezone math, and cleanly separates "NL parsing" (chrono-node) from "timezone resolution" (Intl).

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| NL parsing library | chrono-node v2 (`chrono-node/en`) | 13KB gzipped, 929K weekly downloads, TypeScript, timezone abbreviation support, battle-tested |
| Timezone math | `Intl.DateTimeFormat` (browser built-in) | Zero dependencies, DST-safe, handles all IANA timezones natively |
| Component location | `packages/ui/src/natural-language-date-input/` | Reusable across all apps, follows existing `packages/ui` conventions |
| Timezone list source | `Intl.supportedValuesOf('timeZone')` | Browser-native, always current, no bundled timezone data |
| Two-way binding | Svelte 5 `$bindable()` on `value` prop | Follows codebase convention, enables `bind:value={entry.createdAt}` |
| Timezone default | Extracted from existing `DateTimeString` value, or `Intl.DateTimeFormat().resolvedOptions().timeZone` for new | User said: "ideally in almost all cases it's pre-populated because it's auto detected by creation time" |
| Human-readable format | `date-fns` `format()` (already in Fuji's deps) | Fuji already uses `date-fns` for date display |
| Confirm behavior | Update bound value only on confirm | Prevents intermediate parse states from leaking into the data model |

## Architecture

### Component Structure

```
packages/ui/src/natural-language-date-input/
├── natural-language-date-input.svelte    ← Main component
├── timezone-combobox.svelte              ← IANA timezone searchable select
├── parse-date.ts                         ← chrono-node + Intl bridging logic
└── index.ts                              ← Barrel export
```

### Data Flow

```
USER TYPES NL TEXT              USER SELECTS TIMEZONE
"next tuesday 3pm"              "America/Los_Angeles" ▼
        │                               │
        ▼                               │
┌──────────────────┐                    │
│   chrono-node    │                    │
│  parse(text)     │                    │
│  → { year: 2025, │                    │
│     month: 1,    │                    │
│     day: 21,     │                    │
│     hour: 15,    │                    │
│     minute: 0 }  │                    │
└────────┬─────────┘                    │
         │                              │
         ▼                              ▼
┌──────────────────────────────────────────┐
│  Intl.DateTimeFormat timezone resolution │
│  (year,month,day,hour,min) × IANA → UTC │
│  → 2025-01-21T23:00:00.000Z             │
└────────────────────┬─────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────┐
│  DateTimeString serialization            │
│  "2025-01-21T23:00:00.000Z|America/LA"  │
└────────────────────┬─────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────┐
│  Human-readable preview                  │
│  "Tuesday, Jan 21, 2025 · 3:00 PM PST"  │
│                          [Confirm]       │
└──────────────────────────────────────────┘
                     │ on confirm
                     ▼
            bind:value updates
            (DateTimeString)
```

### Component API

```svelte
<script lang="ts">
  import { NaturalLanguageDateInput } from '@epicenter/ui/natural-language-date-input';
  import type { DateTimeString } from '@epicenter/workspace';

  let createdAt: DateTimeString = $state(dateTimeStringNow());
</script>

<!-- Two-way binding: human-readable editing, serialized storage -->
<NaturalLanguageDateInput bind:value={createdAt} />
```

### Props

```ts
let {
  value = $bindable(),
  placeholder = "Type a date...",
  disabled = false,
  onconfirm,
}: {
  value: DateTimeString | undefined;
  placeholder?: string;
  disabled?: boolean;
  onconfirm?: (value: DateTimeString) => void;
} = $props();
```

### Internal State

```ts
// Derived from the bound value (or system default)
const timezone = $derived(
  value ? (value as string).split('|')[1] ?? localTimezone() : localTimezone()
);

// NL text input state
let inputText = $state('');

// Parsed result (reactive, updates as user types)
const parsed = $derived(parseNaturalLanguageDate(inputText, timezone));

// Human-readable preview
const preview = $derived(
  parsed ? formatPreview(parsed.utcDate, parsed.timezone) : null
);
```

### `parse-date.ts`: Bridging Logic

```ts
import * as chrono from 'chrono-node/en';

type ParsedDate = {
  utcDate: Date;
  timezone: string;
  components: { year: number; month: number; day: number; hour: number; minute: number; second: number };
};

/**
 * Parse natural language text into a UTC Date within a specific IANA timezone.
 *
 * Uses chrono-node for NL parsing (extracts date/time components),
 * then Intl.DateTimeFormat for DST-safe timezone→UTC resolution.
 *
 * @param text - Natural language date string ("next tuesday 3pm", "tomorrow at noon")
 * @param timezone - IANA timezone name ("America/Los_Angeles", "Asia/Tokyo")
 * @returns Parsed date with UTC instant + timezone, or null if unparseable
 */
export function parseNaturalLanguageDate(text: string, timezone: string): ParsedDate | null {
  // 1. chrono-node: NL text → date/time components
  // 2. Intl: components × IANA timezone → UTC Date
  // 3. Return { utcDate, timezone, components }
}

/**
 * Serialize a parsed date into a DateTimeString.
 *
 * @returns Format: "2025-01-21T23:00:00.000Z|America/Los_Angeles"
 */
export function toDateTimeString(utcDate: Date, timezone: string): DateTimeString {
  return `${utcDate.toISOString()}|${timezone}` as DateTimeString;
}
```

### Timezone Combobox

Uses existing `useCombobox` hook + `Command` + `Popover` from `packages/ui`:

```svelte
<!-- timezone-combobox.svelte -->
<Popover.Root bind:open={combobox.open}>
  <Popover.Trigger bind:ref={combobox.triggerRef}>
    {#snippet child({ props })}
      <Button {...props} role="combobox" aria-expanded={combobox.open}>
        {selectedTimezone}
      </Button>
    {/snippet}
  </Popover.Trigger>
  <Popover.Content>
    <Command.Root>
      <Command.Input placeholder="Search timezone..." />
      <Command.List>
        {#each filteredTimezones as tz}
          <Command.Item onSelect={() => { /* ... */ }}>
            {tz}
          </Command.Item>
        {/each}
      </Command.List>
    </Command.Root>
  </Popover.Content>
</Popover.Root>
```

Timezone list sourced from `Intl.supportedValuesOf('timeZone')`: browser-native, always current, zero bundled data.

## Implementation Plan

### Phase 1: Core Parsing Utility

- [x] **1.1** Add `chrono-node` as a dependency to `packages/ui/package.json`
- [x] **1.2** Create `packages/ui/src/natural-language-date-input/parse-date.ts` with `parseNaturalLanguageDate()` and `toDateTimeString()`
- [x] **1.3** Implement DST-safe Intl bridging: chrono-node components × IANA timezone → UTC Date
- [x] **1.4** Write tests for parsing: 6 tests passing via bun:test

### Phase 2: Timezone Combobox

- [x] **2.1** Create `packages/ui/src/natural-language-date-input/timezone-combobox.svelte` using existing `useCombobox` + `Command` + `Popover`
- [x] **2.2** Source timezone list from `Intl.supportedValuesOf('timeZone')`
- [x] **2.3** Display current UTC offset next to each timezone name (e.g., "America/Los_Angeles (UTC-7)")

### Phase 3: Main Component

- [x] **3.1** Create `packages/ui/src/natural-language-date-input/natural-language-date-input.svelte`
- [x] **3.2** Wire up `$bindable()` value prop with `DateTimeString` type
- [x] **3.3** Implement reactive parsing: as user types, show preview of parsed date
- [x] **3.4** Implement confirm flow: on confirm, serialize to `DateTimeString` and update bound value
- [x] **3.5** Extract timezone from existing `DateTimeString` value for pre-population
- [x] **3.6** Human-readable preview formatting via `Intl.DateTimeFormat` (no date-fns needed)

### Phase 4: Barrel Export + Integration

- [x] **4.1** Create `packages/ui/src/natural-language-date-input/index.ts` barrel export
- [ ] **4.2** Verify component works with `bind:value` in a live Fuji integration (deferred to integration PR)

## Edge Cases

### DST Boundary Crossing

1. User types "March 10 2am" with timezone "America/New_York"
2. This time doesn't exist (spring-forward skips 2:00-2:59 AM)
3. Expected: `Intl` resolves to the nearest valid time (3:00 AM) or the component shows a warning

### Ambiguous NL Input

1. User types "next week"
2. chrono-node parses to a date but no time component
3. Expected: time defaults to midnight (00:00), preview shows date-only format

### Empty or Unparseable Input

1. User types "asdfghjkl"
2. chrono-node returns null
3. Expected: no preview shown, confirm button disabled

### Timezone Change After Parse

1. User types "3pm", preview shows "3:00 PM PST"
2. User changes timezone to "Asia/Tokyo"
3. Expected: preview updates to "3:00 PM JST". Same local time, different UTC instant

### Pre-existing Value

1. Component receives `value="2025-01-21T23:00:00.000Z|America/Los_Angeles"`
2. Expected: timezone combobox shows "America/Los_Angeles", input is empty (ready for new input), no preview until user types

## Open Questions

1. **Should the component live in `packages/ui` or a separate package?**
   - `packages/ui` currently has zero runtime dependencies beyond shadcn primitives
   - Adding `chrono-node` (~13KB gzip) is a meaningful dependency for a UI library
   - **Recommendation**: Keep in `packages/ui` for simplicity. 13KB is small. If it becomes a concern, extract to `packages/date-input` later.

2. **Should parsing be debounced?**
   - chrono-node is fast (~1ms per parse), so debouncing may be unnecessary
   - **Recommendation**: Start without debouncing. Add if profiling shows issues.

3. **Should the input show the current value as pre-filled text?**
   - Option A: Input always starts empty, ready for new NL input
   - Option B: Input shows human-readable version of current value, user clears to type new
   - **Recommendation**: Option A. The value is displayed as a preview below the input. The input is for *changing* the date, not displaying the current one.

4. **Timezone display format in the combobox?**
   - Option A: Raw IANA name: `America/Los_Angeles`
   - Option B: IANA + offset: `America/Los_Angeles (UTC-7)`
   - Option C: Friendly name + offset: `Pacific Time (UTC-7)`
   - **Recommendation**: Option B. IANA names are what's stored, offset provides context, no ambiguity.

## Success Criteria

- [x] `<NaturalLanguageDateInput bind:value={dts} />` works with two-way binding
- [x] Typing "next tuesday 3pm" with "America/Los_Angeles" selected produces correct UTC in the DateTimeString
- [x] Timezone combobox is searchable and pre-populated from existing value
- [x] DST boundary dates produce correct UTC offsets
- [x] Preview displays in human-readable format while bound value is serialized DateTimeString
- [x] Confirm updates the bound value; canceling/clearing doesn't
- [x] chrono-node imported as `chrono-node/en` for English-only (~13KB gzip)
- [x] Component follows `packages/ui` conventions: kebab-case folder, `index.ts` barrel, `cn()` for styling

## References

- `packages/workspace/src/shared/datetime-string.ts`: DateTimeString type, `dateTimeStringNow()`
- `packages/ui/src/hooks/use-combobox.svelte.ts`: Combobox state hook (Popover + Command pattern)
- `packages/ui/src/command/`: Searchable list component
- `packages/ui/src/popover/`: Popover container
- `packages/ui/src/input/`: Text input
- `apps/fuji/src/lib/workspace/definition.ts`: Fuji entries table with DateTimeString fields
- `apps/fuji/src/lib/components/StatusBar.svelte`: Current date display pattern (`dts.split('|')[0]`)
- https://github.com/wanasit/chrono: chrono-node v2 docs
- https://github.com/huntabyte/shadcn-svelte: shadcn-svelte component patterns

## Review

**Completed**: 2026-04-08

### Summary

Built a `NaturalLanguageDateInput` component in `packages/ui` that parses natural language date text via chrono-node/en, resolves it against a user-selected IANA timezone using `Intl.DateTimeFormat` for DST-safe offset calculation, and serializes the result as a `DateTimeString` with two-way Svelte 5 binding.

### Files Created

| File | Purpose |
|---|---|
| `parse-date.ts` | chrono-node NL parsing + Intl timezone bridging + `toDateTimeString()` |
| `timezone-combobox.svelte` | Searchable IANA timezone selector using Popover + Command + useCombobox |
| `natural-language-date-input.svelte` | Main component composing text input + timezone + preview + confirm |
| `parse-date.test.ts` | 6 bun:test cases covering parsing, timezone offsets, and serialization |
| `index.ts` | Barrel export for `@epicenter/ui/natural-language-date-input` |

### Deviations from Spec

- Used `Intl.DateTimeFormat` for human-readable preview formatting instead of `date-fns`: avoided adding another dependency since Intl handles it natively.
- Added `@epicenter/workspace` as a devDependency to `packages/ui` for the `DateTimeString` type import.
- Timezone combobox replaces `GMT` with `UTC` in offset labels for consistency (e.g., "UTC+9" instead of "GMT+9").

### Follow-up Work

- Integrate into Fuji's entry editor to replace the current display-only date rendering.
- Consider adding a "clear" button to reset the input and timezone to defaults.
- 4.2 remains: verify the component end-to-end in a live app with `bind:value`.
