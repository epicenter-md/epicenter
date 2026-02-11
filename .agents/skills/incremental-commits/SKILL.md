---
name: incremental-commits
description: Break multi-file changes into atomic commits ordered by dependency. Use for refactors, breaking API changes, or features touching 3+ files.
---

# Incremental Commits

When a feature touches multiple files, implement in **waves**. Each wave is one logical concern, one commit. This creates a clean git history that tells a story.

## The Pattern

```
Wave 1: Foundation (types, interfaces)
  ↓
Wave 2: Factories/Builders (functions that create instances)
  ↓
Wave 3: Contracts/APIs (public interfaces that use types)
  ↓
Wave 4: Infrastructure (utilities, converters, dependencies)
  ↓
Wave 5: Consumers (apps, UI, integrations)
```

Not every change needs all waves. A simple bugfix might be one wave. A cross-cutting refactor might need five.

## Wave Characteristics

Each wave must be:

| Property      | Description                                    |
| ------------- | ---------------------------------------------- |
| **Atomic**    | One logical concern per wave                   |
| **Buildable** | Code compiles after this wave (run type-check) |
| **Focused**   | Changes relate to ONE layer/concern            |
| **Complete**  | No half-done work within a wave                |

## Real Example: Schema Refactor

This feature moved metadata from workspace to tables. Five waves:

### Wave 1: Types

```
feat(schema): add IconDefinition, CoverDefinition, and FieldMetadata types

- Add IconDefinition discriminated union (emoji | external)
- Add CoverDefinition discriminated union (external)
- Add FieldMetadata with optional name/description to all field types
- Update TableDefinition to use icon/cover instead of emoji/order
```

Files: `types.ts` only. Foundation for everything else.

### Wave 2: Factories

```
feat(schema): add optional name/description to field factory functions

All factory functions (id, text, richtext, integer, real, boolean, date,
select, tags, json) now accept optional name and description parameters.
```

Files: `factories.ts` only. Uses types from Wave 1.

### Wave 3: Contracts

```
feat(schema): remove emoji and description from WorkspaceSchema

Workspace is now just a container with guid, id, name, tables, and kv.
Visual metadata (icon, cover, description) now lives on TableDefinition.
```

Files: `contract.ts` only. API change using new types.

### Wave 4: Infrastructure

```
feat(schema): use slugify for human-readable SQL column names

- Add @sindresorhus/slugify dependency
- Add toSqlIdentifier() helper using slugify with '_' separator
- SQLite columns now use field.name (or derived from key) instead of key
```

Files: `to-drizzle.ts`, `package.json`. Utility that uses field metadata.

### Wave 5: Consumers

```
feat(schema): update epicenter app to use TablesWithMetadata

- WorkspaceSchema now accepts TablesSchema | TablesWithMetadata
- Export new types from package index
- Update app to create proper TableDefinition with metadata
```

Files: App files that consume the new types.

## The Workflow

1. **Plan waves before coding**
   - List files that need changes
   - Group by layer/concern
   - Order by dependency (foundations first)

2. **Implement one wave**
   - Make changes for that wave only
   - Resist temptation to "fix one more thing"

3. **Verify the wave**
   - Run type-check: `bun run tsc --noEmit`
   - Ensure no errors introduced

4. **Commit the wave**
   - Use conventional commit format
   - Message describes what this wave accomplishes
   - Body can list specific changes

5. **Repeat for next wave**

## When to Use Waves

| Scenario                 | Waves? | Why                        |
| ------------------------ | ------ | -------------------------- |
| Single file bugfix       | No     | One change, one commit     |
| Add new type + factory   | Maybe  | Could be 1-2 waves         |
| Refactor across 5+ files | Yes    | Need logical grouping      |
| Breaking API change      | Yes    | Types → API → Consumers    |
| Add dependency + use it  | Yes    | Infra wave then usage wave |

## Anti-Patterns

### Giant Commit

```
refactor: update schema system

- Add new types
- Update factories
- Change contracts
- Add slugify
- Update app
```

Problem: One monolithic commit. Can't bisect, can't revert partially, no story.

### Micro Commits

```
feat: add IconDefinition type
feat: add CoverDefinition type
feat: add FieldMetadata type
feat: update IdFieldSchema
feat: update TextFieldSchema
...
```

Problem: Too granular. 20 commits for one logical change. Noise.

### Wrong Order

```
Wave 1: Update app to use new types  ❌
Wave 2: Add the types                 ❌
```

Problem: Wave 1 won't compile. Bottom-up, not top-down.

## Dependency Order Heuristic

When deciding wave order, ask: "What does this file import?"

```
types.ts         → imports nothing (foundation)
factories.ts     → imports types.ts
contract.ts      → imports types.ts
converters.ts    → imports types.ts, may add deps
app/             → imports everything above
```

Files that import nothing come first. Files that import everything come last.

## Branch Strategy

For multi-wave work:

```bash
# Create feature branch
git checkout -b feat/my-feature

# Wave 1
# ... make changes ...
git add <files> && git commit -m "feat(scope): wave 1 description"

# Wave 2
# ... make changes ...
git add <files> && git commit -m "feat(scope): wave 2 description"

# ... continue waves ...

# When done, all waves are individual commits on the branch
# PR shows clean history of how the feature evolved
```

## Quick Reference

Before starting:

- [ ] List all files that need changes
- [ ] Group by layer (types, factories, contracts, infra, consumers)
- [ ] Order by dependency

For each wave:

- [ ] Change only files in this wave
- [ ] Run type-check
- [ ] Commit with descriptive message
- [ ] Move to next wave

After all waves:

- [ ] Final type-check
- [ ] Run tests if applicable
- [ ] Create PR with clean commit history
