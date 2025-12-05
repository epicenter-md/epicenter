# Extract EPICENTER_STORAGE_DIR to Shared Location

## Current State

The `EPICENTER_STORAGE_DIR` constant is defined in two places:
- `src/persistence/desktop.ts` (exported)
- `src/indexes/sqlite/index.ts` (not exported)

Both files define the same constant independently with the same value `'.epicenter'`.

## Desired State

Create a single source of truth for the constant:
- Define it once in a shared location
- Both files import from that location
- Maintains backward compatibility (already exported from persistence/desktop.ts)

## Options

### Option 1: Create src/core/constants.ts
Create a new file for framework-level constants.

**Pros:**
- Clear, discoverable location
- Can hold other constants in the future
- Semantic location (core framework concept)

**Cons:**
- Adds a new file
- Might be overkill for one constant

### Option 2: Keep in persistence/desktop.ts, import in sqlite
Since it's already exported from persistence/desktop.ts, sqlite can just import from there.

**Pros:**
- No new files
- Already exported
- Simple change

**Cons:**
- Creates dependency: sqlite → persistence
- Less semantic (storage dir isn't specific to persistence layer)
- Circular dependency risk if persistence ever needs sqlite

### Option 3: Create src/constants.ts (root level)
Top-level constants file for the entire package.

**Pros:**
- Most general location
- Clear single source of truth
- No cross-layer dependencies

**Cons:**
- Very top-level for what might seem like an implementation detail

## Decision: Option 2 (Keep in persistence/desktop.ts)

Keep the constant in `persistence/desktop.ts` (already exported) since it's only used for desktop persistence right now. SQLite will import from there.

**Rationale:**
- Constant is currently desktop-specific
- Already exported from persistence/desktop.ts
- Simple change with no new files
- If it becomes more general later, can extract then

## Implementation

1. Keep `src/persistence/desktop.ts` as-is (already exported)

2. Update `src/indexes/sqlite/index.ts`:
   - Remove duplicate const definition
   - Add import: `import { EPICENTER_STORAGE_DIR } from '../../persistence/desktop';`

## Todo

- [ ] Remove EPICENTER_STORAGE_DIR from sqlite/index.ts
- [ ] Import from persistence/desktop.ts in sqlite/index.ts
- [ ] Run tests to verify everything works

## Review

Successfully consolidated EPICENTER_STORAGE_DIR constant:
- Removed duplicate definition from `src/indexes/sqlite/index.ts`
- SQLite now imports from `src/persistence/desktop.ts`
- Single source of truth maintained
