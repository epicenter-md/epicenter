# Improve Date Transformation Script Validation

**Date**: 2025-11-14
**Status**: Planning

## Problem

The `02-transform-dates.ts` script currently appends timezones to date fields without validating that they're actually valid ISO datetime strings. This can lead to:

1. Invalid date values being transformed (e.g., `"not-a-date|America/New_York"`)
2. Already-transformed dates being re-transformed (e.g., `"2024-01-01|UTC|America/New_York"`)
3. No error reporting for malformed date values
4. Silent failures that are hard to debug

## Current Implementation

```typescript
// Append timezone to date fields
for (const field of DATE_FIELDS) {
	if (frontmatter[field]) {
		frontmatter[field] = `${frontmatter[field]}|${timezone}`;
	}
}
```

This blindly concatenates without any validation.

## Solution

Use the existing regex patterns from `packages/epicenter/src/core/schema/regex.ts`:

1. **Import regex patterns**: `ISO_DATETIME_REGEX`, `DATE_WITH_TIMEZONE_STRING_REGEX`
2. **Validate before transforming**: Check if the value is a valid ISO datetime string
3. **Skip already-transformed**: Don't re-transform fields that already have timezone
4. **Report invalid dates**: Track and report fields with invalid date values

## Implementation Plan

- [ ] Import regex patterns from `@epicenter/hq/core/schema/regex`
- [ ] Create validation helper function `isValidIsoDateTime(value: unknown): boolean`
- [ ] Create check helper function `isAlreadyTransformed(value: unknown): boolean`
- [ ] Update transformation logic to validate before transforming
- [ ] Add new result type for invalid dates: `{ status: 'invalid'; file: string; field: string; value: unknown }`
- [ ] Update reporting to show invalid dates
- [ ] Test with various date formats

## Expected Behavior

### Valid Transformations
- `"2024-01-01"` → `"2024-01-01|America/New_York"` ✅
- `"2024-01-01T20:00:00.000Z"` → `"2024-01-01T20:00:00.000Z|America/New_York"` ✅

### Skip Cases
- `"2024-01-01|UTC"` → Skip (already has timezone) ⏭️
- `null` or `undefined` → Skip (no value) ⏭️

### Invalid Cases (Report Warning)
- `"not-a-date"` → Report invalid date format ⚠️
- `12345` → Report invalid date format (not string) ⚠️
- `"2024-13-45"` → Report invalid date format (invalid month/day) ⚠️

## Review

### Implementation Summary

Successfully added validation to the date transformation script using centralized helper functions from the schema system.

### Changes Made

1. **Added `isIsoDateTimeString` helper function** (`packages/epicenter/src/core/schema/date-with-timezone.ts:128-131`)
   - Type guard to check if a value is a valid ISO 8601 datetime string
   - Uses `ISO_DATETIME_REGEX` for validation
   - Exported from `@epicenter/hq` for reuse

2. **Updated transformation script** (`examples/content-hub/scripts/02-transform-dates.ts`)
   - Imports `isIsoDateTimeString` and `isDateWithTimezoneString` from `@epicenter/hq`
   - Validates date fields before transformation
   - Skips already-transformed dates (with pipe separator)
   - Reports invalid date values with field name and value
   - Only writes files when modifications are actually made

3. **Enhanced result reporting**
   - Added `invalid` status for dates that don't match ISO format
   - Added `reason` field to `skipped` status for better diagnostics
   - Reports invalid dates separately from errors
   - Shows skip reasons (e.g., "no timezone field", "all dates already transformed")

### Benefits

- **Type safety**: Uses existing type guards from the schema system
- **Centralized logic**: Date validation logic lives in one place
- **Better error reporting**: Users see exactly which fields have invalid values
- **Idempotent**: Can run multiple times without re-transforming
- **No silent failures**: Invalid dates are explicitly reported

### Testing Notes

The script was not tested with actual data as no .env file exists in the examples folder. Future testing should verify:
- Valid ISO dates are transformed correctly
- Already-transformed dates are skipped
- Invalid dates (like "not-a-date") are reported
- Edge cases like missing fields, null values, etc.
