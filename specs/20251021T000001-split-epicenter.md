# Split Epicenter Module Structure

Split `packages/epicenter/src/core/epicenter.ts` into separate files following the same pattern as the workspace module.

## Current Structure
- Single file: `epicenter.ts` (187 lines)
- Contains types, config definition, and client creation logic all mixed together

## Target Structure
Following workspace module pattern:
```
packages/epicenter/src/core/epicenter/
├── README.md       # Architecture documentation
├── index.ts        # Exports from config.ts and client.ts
├── config.ts       # EpicenterConfig type and defineEpicenter function
└── client.ts       # EpicenterClient type and createEpicenterClient function
```

## Tasks

- [ ] Create `packages/epicenter/src/core/epicenter/` directory
- [ ] Create `config.ts` with EpicenterConfig and defineEpicenter
- [ ] Create `client.ts` with EpicenterClient and createEpicenterClient
- [ ] Create `index.ts` with exports
- [ ] Create `README.md` explaining epicenter architecture
- [ ] Update `epicenter.test.ts` imports to use new structure
- [ ] Delete old `epicenter.ts` file
- [ ] Update any other imports of epicenter.ts in the codebase

## Test File Plan

For `epicenter.test.ts`:
- Update import from `./epicenter` to `./epicenter/index` or just `./epicenter` (since index.ts is default)
- No changes to test logic needed, just import paths

## File Breakdown

### config.ts
- `EpicenterConfig` type
- `defineEpicenter` function with validation logic

### client.ts
- `EpicenterClient` type
- `createEpicenterClient` function
- Import `initializeWorkspaces` from workspace/client

### index.ts
- Export types and functions from config.ts
- Export types and functions from client.ts

### README.md
- Explain what epicenter is (collection of workspaces)
- Explain how it differs from workspace
- Explain the flat/hoisted dependency model
- Show usage examples

## Review

Successfully split `epicenter.ts` (187 lines) into modular structure following workspace pattern:

**Created:**
- `packages/epicenter/src/core/epicenter/config.ts` (115 lines): Type definitions and validation
- `packages/epicenter/src/core/epicenter/client.ts` (69 lines): Client creation and lifecycle
- `packages/epicenter/src/core/epicenter/index.ts` (7 lines): Clean export interface
- `packages/epicenter/src/core/epicenter/README.md` (204 lines): Comprehensive architecture docs

**Changed:**
- Updated `epicenter.test.ts` import from `./epicenter` to `./epicenter/index`
- Deleted old `epicenter.ts` file
- All other imports automatically resolve to new `epicenter/index.ts` structure

**Verified:**
- Tests run successfully (11 pass, 2 pre-existing failures unrelated to refactoring)
- All imports resolve correctly to new module structure
- No breaking changes to public API
