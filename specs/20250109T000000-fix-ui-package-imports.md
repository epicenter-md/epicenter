# Fix UI Package Internal Imports

## Problem
The packages/ui directory contains components that are importing from "@epicenter/ui" which creates circular dependencies. These imports need to be changed to relative imports.

## Plan

### Todo Items
- [x] Fix imports in alert-dialog components (8 files)
- [x] Fix imports in accordion components (3 files)
- [x] Fix imports in alert components (3 files)
- [x] Fix imports in badge component (1 file)
- [x] Fix imports in button component (1 file)
- [x] Fix imports in card components (7 files)
- [x] Fix imports in checkbox component (1 file)
- [x] Fix imports in command components (9 files)
- [x] Fix imports in dialog components (2 files)
- [x] Fix imports in dropdown-menu components (9 files)
- [x] Fix imports in input component (1 file)
- [x] Fix imports in label component (1 file)
- [x] Fix imports in popover components (2 files)
- [x] Fix imports in resizable components (2 files)
- [x] Fix imports in scroll-area components (2 files)
- [x] Fix imports in section-header components (3 files)
- [x] Fix imports in select components (9 files)
- [x] Fix imports in separator component (1 file)
- [x] Fix imports in skeleton component (1 file)
- [x] Fix imports in switch component (1 file)
- [x] Fix imports in table components (9 files)
- [x] Fix imports in tabs components (4 files)
- [x] Fix imports in textarea component (1 file)
- [x] Fix imports in toggle component (1 file)
- [x] Fix imports in toggle-group components (2 files)
- [x] Fix imports in tooltip component (1 file)

## Approach
1. Replace "@epicenter/ui/utils" with "../utils" (or appropriate relative path)
2. Replace "@epicenter/ui/[component]/index.js" with "../[component]" (or appropriate relative path)
3. Ensure all imports use proper relative paths based on file location

## Notes
- Total files to update: 87
- Most common imports are utils and button components
- Need to calculate correct relative paths based on directory structure

## Review

### Summary of Changes
Fixed all internal imports in the packages/ui directory by replacing "@epicenter/ui" imports with relative imports. The changes include:

1. Replaced all `@epicenter/ui/utils` imports with `../utils`
2. Replaced all `@epicenter/ui/[component]/index.js` imports with `../[component]/index.js`
3. Replaced all `@epicenter/ui/[component]` imports (without index.js) with `../[component]`

### Implementation Details
- Used a combination of sed commands and manual edits to update all 87 files
- Fixed two different import patterns:
  - Pattern 1: `from '@epicenter/ui/[component]/index.js'` → `from '../[component]/index.js'`
  - Pattern 2: `from '@epicenter/ui/[component]'` → `from '../[component]'`
- Special handling for the SelectAllPopover.svelte file which used a different import pattern

### Verification
- Confirmed no remaining "@epicenter/ui" imports in any svelte or typescript files within packages/ui
- All imports now use relative paths, preventing circular dependency issues