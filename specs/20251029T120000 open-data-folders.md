# Open Data Folders Feature

## Problem

Users on desktop need a way to:
1. Open the folder where recordings are stored (metadata + audio files)
2. Open the folder where transformations are stored (metadata files)
3. Open the folder where transformation runs are stored (metadata files)

This allows users to:
- Browse their data directly in the file explorer
- Backup/export their data manually
- Verify migration has completed successfully
- Understand where their data lives on disk

## Solution

Add "Open Folder" buttons to the recordings and transformations pages that:
- Only show on desktop (check for `window.__TAURI_INTERNALS__`)
- Use Tauri's `openPath` from `@tauri-apps/plugin-opener` to open the folder
- Use the existing `PATHS.DB` constants to get folder paths

## Implementation Plan

### 1. Create reusable component: `OpenFolderButton.svelte`
- [ ] Create new component at `src/lib/components/OpenFolderButton.svelte`
- [ ] Accept props: `folderPath` (async function that returns string)
- [ ] Check for `window.__TAURI_INTERNALS__` - only render on desktop
- [ ] Use `ExternalLink` icon (already used in `DesktopOutputFolder.svelte`)
- [ ] Call folder path function, then use `openPath` to open it
- [ ] Handle errors gracefully with toast notifications

### 2. Add to Recordings page (`/recordings/+page.svelte`)
- [ ] Import `OpenFolderButton` component
- [ ] Import `PATHS` constant
- [ ] Add button near the "Columns" dropdown or other action buttons
- [ ] Pass `PATHS.DB.RECORDINGS` as the folder path
- [ ] Label: "Open Recordings Folder"

### 3. Add to Transformations page (`/transformations/+page.svelte`)
- [ ] Import `OpenFolderButton` component
- [ ] Import `PATHS` constant
- [ ] Add button near the "Create Transformation" button
- [ ] Pass `PATHS.DB.TRANSFORMATIONS` as the folder path
- [ ] Label: "Open Transformations Folder"

### 4. (Optional) Add Transformation Runs folder access
**Decision needed**: Where should this button go?
- Option A: Add to transformations page (shows 2 buttons: transformations + runs)
- Option B: Don't add it (users rarely need direct access to runs)
- Option C: Add to settings page under a "Data Management" section

**Recommendation**: Option B for now - runs are accessed through the transformations UI, and users don't typically need direct file access. Can add later if requested.

## Technical Details

### Component Interface
```typescript
type OpenFolderButtonProps = {
  getFolderPath: () => Promise<string>;
  tooltipText: string;
  buttonText?: string; // Optional text label
  variant?: 'icon' | 'default'; // icon-only or with text
};
```

### Error Handling
- If `getFolderPath()` fails, show error toast
- If `openPath()` fails, show error toast
- Gracefully handle case where folder doesn't exist yet (pre-migration)

### UI Placement

**Recordings Page**:
- Add next to the "Columns" dropdown in the top-right area
- Use icon-only button to save space
- Tooltip: "Open recordings folder"

**Transformations Page**:
- Add next to the "Create Transformation" button
- Use icon-only button to save space
- Tooltip: "Open transformations folder"

## Benefits

1. **Transparency**: Users can see exactly where their data is stored
2. **Migration verification**: Users can verify files were migrated successfully
3. **Manual backup**: Users can easily copy their data for backup
4. **Debug/support**: Easier for users to share their data structure when reporting issues
5. **Trust**: Reinforces that data is truly local and accessible

## Implementation Review

### What Was Built

1. **OpenFolderButton.svelte**: Reusable component at `src/lib/components/OpenFolderButton.svelte`
   - Comprehensive JSDoc comments explaining purpose, use cases, and API
   - Only renders on desktop (checks `window.__TAURI_INTERNALS__`)
   - Accepts async `getFolderPath` function that returns absolute path
   - Uses `tryAsync` from wellcrafted for error handling (no try-catch)
   - Shows error toasts on failure using `rpc.notify.error`
   - Supports both icon-only and with-text variants
   - Well-documented props with JSDoc for each parameter

2. **Recordings Page**: Added button next to "Columns" dropdown
   - Opens `PATHS.DB.RECORDINGS` folder
   - Icon-only button with "Open recordings folder" tooltip

3. **Transformations Page**: Added button next to "Create Transformation" button
   - Opens `PATHS.DB.TRANSFORMATIONS` folder
   - Icon-only button with "Open transformations folder" tooltip

4. **DesktopOutputFolder.svelte** - Kept original implementation:
   - Initially attempted refactoring but reverted
   - Reason: Component needs `disabled` state based on `displayPath === null`
   - `OpenFolderButton` doesn't support disabled state by design (for static, always-available paths)
   - Specialized use case better served by inline implementation

### Design Decisions

**Why OpenFolderButton doesn't support `disabled` prop:**
- Designed for static folder paths that are always available (e.g., `PATHS.DB.RECORDINGS`)
- These folders exist as soon as the app starts (created by migration or first write)
- Adding `disabled` would complicate the simple, focused API
- Components with dynamic/conditional folder paths (like `DesktopOutputFolder`) should handle their own logic

**Error Handling Pattern:**
- Uses `tryAsync` from wellcrafted/result instead of try-catch
- Follows codebase pattern for graceful error handling
- Shows user-friendly toast notifications on failure

**Documentation:**
- HTML comment block at top explains component purpose and usage
- JSDoc on all props for IDE autocomplete
- Inline comments on complex logic

### Benefits Achieved

- **Focused component**: Single responsibility, well-documented
- **Consistent UX**: All static folder buttons look and behave the same
- **Type safety**: Strong typing for `getFolderPath` function
- **Error handling**: Graceful failure with user feedback
- **Flexibility**: Variant prop allows icon-only or with-text display

## Future Enhancements

- Add button to settings page for all data folders
- Add "Open App Data Folder" button to open parent directory
- Add file count badges (e.g., "23 recordings" next to button)
- Add migration status indicator (e.g., "Migration complete ✓")
