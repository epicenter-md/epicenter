# Transformation Schema Versioning

## Status: Complete

## Summary

This document covers the implementation of schema versioning for TransformationStep and Transformation types, enabling migration from V1 (without Custom provider fields) to V2 (with Custom provider fields).

## Current Implementation

### Schema Types (transformations.ts)

V1 and V2 share base fields to avoid repetition while maintaining clear versioning.
When adding V3, either extend the base or define V3 from scratch if base fields change.

```
SHARED BASE FIELDS (frozen for V1/V2):
┌─────────────────────────────────────────────────────────────────┐
│ TransformationStepBaseFields: id, type, provider fields, etc.   │
│ TransformationBaseFields: id, title, description, timestamps    │
└─────────────────────────────────────────────────────────────────┘

VERSION 1 (FROZEN):
┌─────────────────────────────────────────────────────────────────┐
│ TransformationStepV1 = { version: 1, ...BaseFields }            │
│ TransformationV1 = { ...BaseFields, steps: StepV1[] }           │
└─────────────────────────────────────────────────────────────────┘

VERSION 2 (CURRENT):
┌─────────────────────────────────────────────────────────────────┐
│ TransformationStepV2 = { version: 2, ...BaseFields, Custom.* }  │
│ TransformationV2 = { ...BaseFields, steps: StepV2[] }           │
└─────────────────────────────────────────────────────────────────┘

MIGRATING VALIDATORS (accept any version, output V2):
┌─────────────────────────────────────────────────────────────────┐
│ TransformationStep = V1.or(V2).pipe() → V2                      │
│ Transformation = { ...BaseFields, steps: TransformationStep[] } │
└─────────────────────────────────────────────────────────────────┘
```

### Key Types

| Type | Purpose |
|------|---------|
| `TransformationStepV1` | FROZEN: Old schema (version defaults to 1, no Custom fields) |
| `TransformationStepV2` | CURRENT: Latest schema (version=2, has Custom fields) |
| `TransformationV1` | FROZEN: For typing old data in Dexie migrations |
| `TransformationV2` | CURRENT: Latest Transformation schema (strict V2 only) |
| `TransformationStep` | Migrating validator: accepts V1 or V2, outputs V2 |
| `Transformation` | Migrating validator: accepts V1 or V2 steps, outputs V2 |

### Version Field Behavior

- `TransformationStepV1`: `version: '1 = 1'` (arktype syntax for default)
- `TransformationStepV2`: `version: '2'` (literal 2)
- Old data without `version` field gets `version: 1` via arktype default
- Migration sets `version: 2` and adds Custom fields

**Is the version field worth it?** Yes. Without it, arktype would need to distinguish V1 from V2 by field presence. The explicit discriminator makes migration logic cleaner and more readable for a small cost (one number per step).

## Storage Backend Migration

### IndexedDB (web.ts)

**Mechanism:** Dexie V0.6 upgrade runs once

```typescript
// Read with V1 type
const transformations = await tx.table<TransformationV1>('transformations').toArray();

// Migrate steps
const updatedSteps = transformation.steps.map((step) => ({
  ...step,
  version: 2 as const,
  'prompt_transform.inference.provider.Custom.model': '',
  'prompt_transform.inference.provider.Custom.baseUrl': '',
}));

// Write with current type
await tx.table<Transformation>('transformations').update(id, { steps: updatedSteps });
```

**Note:** Dexie generics are type hints only; no runtime validation.

### File System (file-system.ts)

**Mechanism:** `Transformation` validator on every read (auto-migrates)

```typescript
const { data } = matter(content);
const validated = Transformation(data);  // V1 → V2 via .pipe()
```

**Behavior:**
- Old files (V1) are migrated in memory on read
- Persists to disk only when user saves
- No separate migration script needed

## Trade-offs Considered

### Version in Storage

| Approach | Pros | Cons |
|----------|------|------|
| Explicit version | Clear, easy to detect | Need migration script for files |
| Arktype defaults (current) | No file changes needed | Version is implicit |

**Decision:** Use arktype defaults. Files migrate lazily on edit.

### File Migration Strategy

| Strategy | Description | Chosen? |
|----------|-------------|---------|
| Lazy | Migrate on read, persist on save | Yes |
| Eager script | Walk all files, update immediately | No |
| Version file | Track schema version separately | No (overkill) |

## Files Changed

- `apps/whispering/src/lib/services/db/models/transformations.ts` - Schema definitions
- `apps/whispering/src/lib/services/db/models/index.ts` - Exports
- `apps/whispering/src/lib/services/db/web.ts` - Dexie V0.6 migration
- `apps/whispering/src/lib/services/db/file-system.ts` - Uses `Transformation` for reads

## Outstanding Questions

1. **Should we eagerly migrate existing markdown files?**
   - Currently: No, lazy migration via arktype is sufficient
   - Could add a one-time script if needed

2. **Do TransformationRuns need versioning?**
   - Not currently addressed
   - Steps in runs might reference old schema

3. **Testing the migration**
   - Need to test with actual V1 data in IndexedDB
   - Need to test with V1 markdown files

## Next Steps

- [ ] Test Dexie migration with existing data
- [ ] Verify arktype migration works for markdown files
- [ ] Consider if TransformationRuns need similar versioning
- [ ] Review whether Custom provider fields need additional validation

## Related Files

- `apps/whispering/src/lib/services/db/file-system.ts` - File system DB implementation
- `apps/whispering/src/lib/constants/inference.ts` - INFERENCE_PROVIDERS constant
- `apps/whispering/src/lib/settings/settings.ts` - Custom provider settings

## Review

### Changes Made

1. **Extracted shared base fields**

   `TransformationStepBaseFields` and `TransformationBaseFields` contain fields shared between V1 and V2. This avoids repetition while keeping the version-specific additions (Custom.model, Custom.baseUrl) separate.

   The bases are frozen for V1/V2. If V3 needs different base fields, either extend or create a new base.

2. **Renamed `TransformationMigrating` to `Transformation`**

   The main `Transformation` validator now accepts V1 or V2 and auto-migrates to V2. When you need the strict V2 type (no migration), use `TransformationV2` directly.

3. **Simplified type hierarchy**

   - `TransformationV1`, `TransformationV2`: Strict versioned types
   - `Transformation`, `TransformationStep`: Migrating validators that accept any version
   - Use versioned types (`TransformationV2`) when you need strict typing
   - Use migrating validators (`Transformation`) when reading potentially old data

### Design Philosophy

- Shared base fields reduce repetition while keeping versions explicit
- `Transformation` is the union that auto-migrates; use `TransformationV2` for strict typing
- Version field is worth the small cost for explicit migration logic
- When adding V3: extend base if fields are additive, or define from scratch if base changes

### Implementation Summary

The schema versioning system now works as follows:

1. **IndexedDB (web)**: Dexie V0.6 migration runs once per user, reading old data as `TransformationV1`, adding version=2 and Custom fields, then writing back
2. **File system (desktop)**: `Transformation` validator accepts V1 or V2 and outputs V2; old files migrate in memory and persist when user saves

### Remaining Considerations

The outstanding questions from the spec remain valid considerations for future work:
- TransformationRuns may need similar versioning if they store step snapshots
- Testing should be done with actual V1 data to verify the migration paths work correctly
