# Move Examples to Root Level with Package Imports

## Problem
Examples currently live inside `packages/epicenter/examples/` and use relative imports (`../../src/index`). This doesn't demonstrate how real users would consume the `@epicenter/hq` package.

## Solution
Move examples to root-level `examples/` directory and use proper package imports (`@epicenter/hq`).

## Todo Items
- [x] Create `examples/` directory at root
- [x] Update root `package.json` to include `examples/*` in workspaces
- [x] Move `content-hub` example to `examples/content-hub`
- [x] Move `basic-workspace` example to `examples/basic-workspace`
- [x] Create `package.json` for content-hub example
- [x] Create `package.json` for basic-workspace example
- [x] Update all imports in content-hub to use `@epicenter/hq`
- [x] Update all imports in basic-workspace to use `@epicenter/hq`
- [x] Update test files to use package imports
- [x] Remove old examples directory from packages/epicenter
- [x] Test that examples work with new structure

## Implementation Details

### New Structure
```
/examples/
├── content-hub/
│   ├── package.json
│   ├── epicenter.config.ts
│   ├── cli.ts
│   └── workspaces/
│       ├── shared/
│       │   ├── schemas.ts
│       │   └── niches.ts
│       └── [15 workspace files].ts
└── basic-workspace/
    ├── package.json
    ├── epicenter.config.ts
    └── cli.ts
```

### Import Changes
- From: `import { defineEpicenter } from '../../src/index'`
- To: `import { defineEpicenter } from '@epicenter/hq'`

- From: `import { setupPersistence } from '../../src/core/workspace/providers'`
- To: `import { setupPersistence } from '@epicenter/hq/providers'`

## Review

Successfully migrated both examples to root-level `examples/` directory with proper package imports. All changes implemented:

### Structure Changes
- Created `examples/` directory at project root
- Added `examples/*` to workspace configuration in root `package.json`
- Moved `content-hub` and `basic-workspace` from `packages/epicenter/examples/` to `examples/`
- Moved `shared/` folder into `workspaces/` for better organization in content-hub

### Package Configuration
Each example now has its own `package.json` with:
- Private package flag
- Workspace dependency on `@epicenter/hq`
- Required dependencies (arktype, wellcrafted, yargs)
- CLI script for running the example

### Import Updates
All imports updated from relative paths to package imports:
- `../../src/index` → `@epicenter/hq`
- `../../src/core/workspace/providers` → `@epicenter/hq/providers`
- `../../src/cli/index.ts` → `@epicenter/hq/cli`

Updated files:
- All workspace TypeScript files (15+ in content-hub, 1 in basic-workspace)
- Config files (epicenter.config.ts)
- CLI files (cli.ts)
- Test files (*.test.ts)
- Shared schema files

### Testing
Both examples successfully run with the new structure:
- `content-hub`: CLI shows all 15 workspaces and serve command
- `basic-workspace`: CLI shows blog workspace and serve command

### Benefits Achieved
1. Examples now demonstrate real-world package consumption
2. Cleaner separation between package source and examples
3. Better discoverability at root level
4. Examples can be easily copied as starting points for new projects
5. Monorepo best practices followed
