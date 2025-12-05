# Rename `workspaces` to `workspaceConfigs` Refactoring

## Overview
Rename the `workspaces` store to `workspaceConfigs` to better reflect that it stores workspace configuration objects, not workspace instances themselves.

## Todo Items
- [ ] Update the store variable name from `workspaces` to `workspaceConfigs` in workspaces.svelte.ts
- [ ] Update the localStorage key from 'opencode-workspaces' to 'opencode-workspace-configs'
- [ ] Find all imports of `workspaces` across the codebase
- [ ] Update all references to `workspaces.value` to `workspaceConfigs.value`
- [ ] Update any destructured imports or references
- [ ] Test that workspace persistence still works after the changes

## Files to Check
- apps/sh/src/lib/stores/workspaces.svelte.ts (main file)
- Any files importing from this store
- Components using workspace data

## Review

### Summary of Changes
1. **Renamed the store variable**: `workspaces` → `workspaceConfigs` in workspaces.svelte.ts
2. **Updated localStorage key**: 'opencode-workspaces' → 'opencode-workspace-configs'
3. **Updated all store references**: All instances of `workspaces.value` changed to `workspaceConfigs.value`
4. **Updated imports**: Changed imports from `{ workspaces }` to `{ workspaceConfigs }`
5. **Updated component props**: Changed `workspace` prop to `workspaceConfig` in WorkspaceConnectionBadge component
6. **Updated prop references**: Updated the WorkspaceConnectionBadge usage in +page.svelte to use the new prop name

### Files Modified
- `apps/sh/src/lib/stores/workspaces.svelte.ts` - Main store file
- `apps/sh/src/lib/query/workspaces.ts` - Query layer using the store
- `apps/sh/src/lib/components/DeleteWorkspaceButton.svelte` - Component using the store
- `apps/sh/src/routes/workspaces/+page.svelte` - Page using the store
- `apps/sh/src/lib/components/WorkspaceConnectionBadge.svelte` - Component prop name updated

### Files Checked (No Changes Needed)
- `apps/sh/src/lib/components/CreateWorkspaceModal.svelte` - Only imports helper functions
- `apps/sh/src/lib/components/EditWorkspaceButton.svelte` - Already uses workspaceConfig prop
- `apps/sh/src/routes/workspaces/[id]/+page.svelte` - Only imports getWorkspace function
- `apps/sh/src/lib/stores/messages.svelte.ts` - Only imports WorkspaceConfig type

### Next Steps
- Test the application to ensure workspace persistence works correctly
- Verify that existing workspaces are migrated from the old localStorage key

### Additional Changes Completed
1. **Renamed store file**: `workspaces.svelte.ts` → `workspace-configs.svelte.ts`
2. **Updated function names**:
   - `createWorkspace` → `createWorkspaceConfig`
   - `updateWorkspace` → `updateWorkspaceConfig`
   - `deleteWorkspace` → `deleteWorkspaceConfig` (was already done)
   - `getWorkspace` → `getWorkspaceConfig` (was already done)
3. **Renamed component files**:
   - `CreateWorkspaceModal.svelte` → `CreateWorkspaceConfigModal.svelte`
   - `EditWorkspaceButton.svelte` → `EditWorkspaceConfigButton.svelte`
   - `DeleteWorkspaceButton.svelte` → `DeleteWorkspaceConfigButton.svelte`
   - `WorkspaceConnectionBadge.svelte` → `WorkspaceConfigConnectionBadge.svelte`
4. **Updated all imports** across the codebase to use the new file names and paths

### All Files Updated
- Store file renamed and functions updated
- All component files renamed
- All imports updated to use new paths
- All component usage updated to use new names
- All prop names consistently use `workspaceConfig`