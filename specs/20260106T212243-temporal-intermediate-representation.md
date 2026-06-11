# Temporal API as Intermediate Representation for DateWithTimezone

## Status: Draft

## Problem

The current `DateWithTimezone` intermediate representation is a plain object:

```typescript
type DateWithTimezone = {
	date: Date; // JS Date (limited API, mutable, timezone-unaware)
	timezone: string; // IANA timezone
	toJSON(): DateWithTimezoneString;
};
```

This has several limitations:

1. **No date math**: Adding days/months requires external libraries or manual calculation
2. **No timezone conversion**: Converting to display in user's timezone requires manual work
3. **Mutable Date object**: JS `Date` is mutable, can lead to bugs
4. **No DST awareness**: Date math doesn't account for daylight saving transitions
5. **Redundant with Temporal**: We're essentially building a poor version of `Temporal.ZonedDateTime`

## Solution

Replace the intermediate representation with `Temporal.ZonedDateTime` while keeping the same storage format.

### What Stays the Same

**Storage format**: `"2024-01-01T20:00:00.000Z|America/New_York"`

This format is:

- SQLite sortable (UTC first)
- Cross-platform parseable (simple pipe split)
- Already in production

### What Changes

**Intermediate representation**: From custom object to `Temporal.ZonedDateTime`

```typescript
// Before
const dt = DateWithTimezone({ date: new Date(), timezone: 'America/New_York' });
dt.date; // JS Date
dt.timezone; // string
dt.toJSON(); // "2024-01-01T20:00:00.000Z|America/New_York"

// After
const dt = ZonedDateTime.now('America/New_York');
dt.toInstant(); // Temporal.Instant
dt.timeZoneId; // "America/New_York"
dt.toString(); // Temporal format (for debugging)
toStorageString(dt); // "2024-01-01T20:00:00.000Z|America/New_York"
```

## API Design

### Option A: Wrapper Type (Recommended)

Create a thin wrapper that uses Temporal internally but exposes our serialization:

```typescript
import { Temporal } from 'temporal-polyfill';

// Branded string type (unchanged)
export type DateTimeString = `${string}Z|${string}` & Brand<'DateTimeString'>;

// The intermediate representation IS a Temporal.ZonedDateTime
export type DateTime = Temporal.ZonedDateTime;

// Factory functions
export const DateTime = {
	/**
	 * Create from components
	 */
	from(options: {
		year: number;
		month: number;
		day: number;
		hour?: number;
		minute?: number;
		second?: number;
		millisecond?: number;
		timezone: string;
	}): DateTime {
		return Temporal.ZonedDateTime.from({
			...options,
			timeZone: options.timezone,
		});
	},

	/**
	 * Create from JS Date + timezone
	 */
	fromDate(date: Date, timezone: string): DateTime {
		const instant = Temporal.Instant.fromEpochMilliseconds(date.getTime());
		return instant.toZonedDateTimeISO(timezone);
	},

	/**
	 * Create for current moment in timezone
	 */
	now(timezone: string): DateTime {
		return Temporal.Now.zonedDateTimeISO(timezone);
	},

	/**
	 * Parse from storage string "UTC|timezone"
	 */
	parse(str: DateTimeString): DateTime {
		const [instant, tz] = str.split('|');
		return Temporal.Instant.from(instant).toZonedDateTimeISO(tz);
	},

	/**
	 * Serialize to storage string "UTC|timezone"
	 */
	stringify(dt: DateTime): DateTimeString {
		return `${dt.toInstant()}|${dt.timeZoneId}` as DateTimeString;
	},

	/**
	 * Type guard for storage string
	 */
	isDateTimeString(value: unknown): value is DateTimeString {
		if (typeof value !== 'string') return false;
		return DATE_TIME_STRING_REGEX.test(value);
	},
};
```

### Option B: Re-export Temporal with Helpers

Just re-export Temporal types and provide standalone helpers:

```typescript
import { Temporal } from 'temporal-polyfill';

// Re-export the types users need
export type { Temporal };
export type ZonedDateTime = Temporal.ZonedDateTime;
export type Instant = Temporal.Instant;

// Storage format helpers
export function parseDateTime(str: DateTimeString): Temporal.ZonedDateTime {
	const [instant, tz] = str.split('|');
	return Temporal.Instant.from(instant).toZonedDateTimeISO(tz);
}

export function stringifyDateTime(dt: Temporal.ZonedDateTime): DateTimeString {
	return `${dt.toInstant()}|${dt.timeZoneId}` as DateTimeString;
}
```

## Naming Decision

| Current Name             | Option 1         | Option 2              | Option 3                |
| ------------------------ | ---------------- | --------------------- | ----------------------- |
| `DateWithTimezone`       | `DateTime`       | `ZonedDateTime`       | Keep `DateWithTimezone` |
| `DateWithTimezoneString` | `DateTimeString` | `ZonedDateTimeString` | Keep current            |

**Recommendation**: `DateTime` and `DateTimeString`

Reasons:

- Shorter and cleaner
- Doesn't conflict with Temporal's `ZonedDateTime` (we're wrapping it)
- `DateTime` is familiar from other languages (C#, Python)
- Breaking change anyway, might as well pick the best name

## Migration Path

### Phase 1: Add New API (Non-Breaking)

1. Add `temporal-polyfill` dependency
2. Create new `DateTime` namespace alongside existing `DateWithTimezone`
3. Both can parse/stringify the same storage format
4. Update docs to recommend `DateTime` for new code

### Phase 2: Migrate Usages

1. Update internal usages (tests, examples)
2. Update schema factory default handling
3. Update SQLite builder normalization

### Phase 3: Deprecate Old API

1. Mark `DateWithTimezone` as deprecated
2. Provide codemod or migration guide
3. Remove in next major version

## Implementation Checklist

- [x] Add `temporal-polyfill` to dependencies
- [x] Create `src/core/schema/runtime/datetime.ts` with new API
- [x] Add `ISO_UTC_EXACT_REGEX` for strict validation (DONE)
- [x] Update regex to use strict format (DONE)
- [x] Export new types from `index.ts`
- [x] Update `date()` SQLite builder to use `customType` with Temporal
- [x] Update `to-drizzle.ts` type mapping to `SQLiteCustomColumnBuilder`
- [ ] Update arktype converter (future)
- [ ] Migrate tests (future)
- [ ] Deprecate old API (future)
- [ ] Update documentation (future)

## Usage Examples

### Creating DateTimes

```typescript
import { DateTime } from '@epicenter/workspace';

// Current moment in a timezone
const now = DateTime.now('America/New_York');

// From components
const meeting = DateTime.from({
	year: 2025,
	month: 1,
	day: 15,
	hour: 14,
	minute: 30,
	timezone: 'America/Los_Angeles',
});

// From JS Date (e.g., from a date picker)
const fromPicker = DateTime.fromDate(pickerValue, userTimezone);
```

### Date Math (DST-Safe)

```typescript
// Add 1 month - automatically handles DST
const nextMonth = meeting.add({ months: 1 });

// Add 2 weeks
const twoWeeksLater = meeting.add({ weeks: 2 });

// Difference between dates
const duration = meeting.until(nextMonth);
console.log(duration.total('days')); // ~30
```

### Timezone Conversion

```typescript
// Convert for display in user's timezone
const userView = meeting.withTimeZone('Europe/London');
console.log(userView.hour); // Different hour, same instant

// Format for display
const formatted = meeting.toLocaleString('en-US', {
	dateStyle: 'full',
	timeStyle: 'short',
});
```

### Storage Roundtrip

```typescript
// Serialize for storage
const stored = DateTime.stringify(meeting);
// => "2025-01-15T22:30:00.000Z|America/Los_Angeles"

// Parse from storage
const restored = DateTime.parse(stored);
// Full Temporal.ZonedDateTime with all methods
```

## Bundle Size Consideration

| Package                 | Size (min+gzip) |
| ----------------------- | --------------- |
| `temporal-polyfill`     | ~20 KB          |
| `@js-temporal/polyfill` | ~52 KB          |

**Recommendation**: Use `temporal-polyfill` (smaller, actively maintained)

Once browsers ship native Temporal support, the polyfill can be dropped with zero code changes.

## Questions to Resolve

1. **Naming**: `DateTime` vs `ZonedDateTime` vs keep `DateWithTimezone`?
2. **API style**: Wrapper namespace (Option A) vs standalone functions (Option B)?
3. **Breaking change strategy**: Major version bump or deprecation period?

## Related Files

- `packages/epicenter/src/core/schema/runtime/date-with-timezone.ts` - Current implementation
- `packages/epicenter/src/core/schema/runtime/regex.ts` - Validation patterns
- `packages/epicenter/src/core/schema/fields/factories.ts` - Schema factory
- `packages/epicenter/src/providers/sqlite/schema/builders.ts` - SQLite handling

## Implementation Review (2026-01-06)

### Decision: Option B (Standalone Functions)

Went with the simpler approach. No wrapper namespace. Just use `Temporal.ZonedDateTime` directly with two helper functions for serialization:

```typescript
import { Temporal, toDateTimeString, fromDateTimeString } from '@epicenter/workspace';

// Create - use Temporal directly
const now = Temporal.Now.zonedDateTimeISO('America/New_York');

// Store
const stored = toDateTimeString(now); // "2025-01-06T21:30:00.000Z|America/New_York"

// Retrieve
const restored = fromDateTimeString(stored); // Temporal.ZonedDateTime
```

### Files Changed

| File                                                          | Change                                                                |
| ------------------------------------------------------------- | --------------------------------------------------------------------- |
| `packages/epicenter/package.json`                             | Added `temporal-polyfill@0.3.0`                                       |
| `packages/epicenter/src/core/schema/runtime/datetime.ts`      | NEW - `toDateTimeString`, `fromDateTimeString`                        |
| `packages/epicenter/src/providers/sqlite/schema/builders.ts`  | `date()` uses `customType` returning `Temporal.ZonedDateTime`         |
| `packages/epicenter/src/core/schema/converters/to-drizzle.ts` | Type uses `SQLiteCustomColumnBuilder<{data: Temporal.ZonedDateTime}>` |
| `packages/epicenter/src/core/schema/index.ts`                 | Exports `Temporal`, `toDateTimeString`, `fromDateTimeString`          |

### Breaking Change

The `date()` column now returns `Temporal.ZonedDateTime` on read instead of storing/returning plain strings. This is a breaking change for any code that expects string values from date columns.

### Migration Path

Old API (`DateWithTimezone`) still works and is not removed. New code should use Temporal directly.
