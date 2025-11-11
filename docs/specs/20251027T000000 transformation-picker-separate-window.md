# Convert TransformationPickerDialog to Separate Tauri Window

**Date**: 2025-10-27
**Status**: Completed

## Overview

Convert the `TransformationPickerDialog` component from a shadcn-svelte Dialog modal into a separate native Tauri window. This will provide a better user experience with native window controls, built-in always-on-top functionality, and better multi-monitor support.

## Current State

The TransformationPickerDialog is currently:
- A Svelte component using shadcn-svelte Dialog primitives
- Rendered within the main application window as a modal overlay
- Uses module-level state management (`transformationPickerDialog`)
- Manually manages always-on-top behavior on the main window

## Desired State

The transformation picker should be:
- A separate native Tauri WebviewWindow
- Created conditionally when needed (on-demand)
- Has built-in always-on-top functionality
- Uses Tauri's event system for inter-window communication
- Maintains the same UI and functionality

## Architecture Decisions

### Window Creation Strategy
**Choice**: Lazy creation (create window when needed, destroy when closed)

**Rationale**:
- Simpler state management
- Lower memory footprint when not in use
- No hidden windows consuming resources
- Follows principle of simplicity from CLAUDE.md

**Alternative considered**: Pre-create hidden window
- Would be faster to show
- But adds complexity and resource usage
- Not worth the trade-off for this use case

### Communication Pattern
**Choice**: Tauri event system with typed events

**Rationale**:
- Native Tauri approach
- Type-safe with proper TypeScript definitions
- Bidirectional communication support
- Well-documented pattern

## Todo Items

### Phase 1: Setup and Infrastructure
- [ ] Create new route `/transformation-picker` for the separate window
- [ ] Create `TransformationPickerWindow.svelte` page component
- [ ] Add TypeScript types for inter-window events
- [ ] Create window manager utility for creating/managing the picker window

### Phase 2: Window Management
- [ ] Implement `createTransformationPickerWindow()` function
- [ ] Implement window lifecycle management (create, show, close)
- [ ] Add error handling for window creation failures
- [ ] Test window creation and destruction

### Phase 3: Inter-Window Communication
- [ ] Set up event emitter for passing clipboard text to picker window
- [ ] Set up event listener in picker window to receive clipboard text
- [ ] Set up event emitter from picker window back to main window on transformation complete
- [ ] Test bidirectional communication

### Phase 4: UI Migration
- [ ] Move TransformationPickerDialog UI to new TransformationPickerWindow page
- [ ] Update styling to work as standalone window (remove dialog-specific styles)
- [ ] Ensure TransformationPickerBody component works in new context
- [ ] Test UI rendering and interactions

### Phase 5: Integration and Cleanup
- [ ] Update call sites that open `transformationPickerDialog.open()` to use new window API
- [ ] Remove old TransformationPickerDialog component
- [ ] Remove always-on-top management code (no longer needed)
- [ ] Update imports across codebase

### Phase 6: Testing
- [ ] Test opening picker from keyboard shortcut
- [ ] Test opening picker from menu/button
- [ ] Test transformation execution and result delivery
- [ ] Test window focus and always-on-top behavior
- [ ] Test closing window (both via close button and programmatically)
- [ ] Test error cases (window creation failure, transformation errors)

## Technical Implementation Details

### Window Configuration
```typescript
{
  label: 'transformation-picker',
  url: '/transformation-picker',
  title: 'Transform Clipboard',
  width: 600,
  height: 500,
  center: true,
  alwaysOnTop: true,
  decorations: true,
  resizable: false,
  focus: true,
  visible: true
}
```

### Event Types
```typescript
type TransformationPickerEvents = {
  'open-transformation-picker': { clipboardText: string };
  'transformation-complete': { output: string; toastId: string };
  'picker-closed': {};
};
```

### File Structure
```
apps/whispering/src/
├── lib/
│   ├── components/
│   │   ├── TransformationPickerBody.svelte (keep, reuse)
│   │   └── TransformationPickerDialog.svelte (remove)
│   └── tauri/
│       └── transformationPickerWindow.ts (new)
└── routes/
    └── transformation-picker/
        └── +page.svelte (new)
```

## Benefits

1. **Native window controls**: Users can move, minimize, maximize the picker naturally
2. **Always-on-top built-in**: No manual setting/restoration of main window state
3. **Better multi-monitor support**: Window can be positioned on any screen
4. **Independent lifecycle**: Picker can stay open while user navigates main app
5. **Cleaner state management**: Window has isolated context
6. **Better resource management**: Window only exists when needed

## Risks and Mitigations

### Risk: Window creation failure
**Mitigation**: Proper error handling with fallback to inline dialog if needed

### Risk: Lost inter-window messages
**Mitigation**: Implement message acknowledgment pattern if needed

### Risk: Window position not remembered
**Mitigation**: Could add window position persistence (future enhancement)

## Open Questions
- Should we persist window position between opens?
- Should window be closable via Escape key?
- Should we support multiple picker windows open simultaneously?

## Review

**Implementation Date**: 2025-10-27

### Changes Made

1. **Created new route structure**
   - Added `/transformation-picker` route with `+page.svelte`
   - Implemented standalone page layout with proper spacing and styling

2. **Created TypeScript types**
   - Added `apps/whispering/src/lib/tauri/events.ts` with typed event definitions
   - Defined `TransformationPickerEvents` type for type-safe inter-window communication

3. **Created window manager utility**
   - Added `apps/whispering/src/lib/tauri/transformationPickerWindow.ts`
   - Implemented `openTransformationPicker(clipboardText)` function
   - Implemented `closeTransformationPicker()` function
   - Added window existence checking and reuse logic
   - Configured window with `alwaysOnTop: true` and appropriate dimensions

4. **Migrated UI components**
   - Moved transformation picker UI from dialog to standalone page
   - Reused existing `TransformationPickerBody` component (no changes needed)
   - Removed dialog-specific wrapper elements (Dialog.Root, Dialog.Content, etc.)
   - Updated styling to work as full-page layout

5. **Implemented event system**
   - Set up event listener in picker window to receive clipboard text
   - Set up event emitter in window manager to send clipboard text
   - Automatic window close on transformation selection

6. **Updated integration points**
   - Modified `apps/whispering/src/lib/query/commands.ts`:
     - Changed import from `transformationPickerDialog` to `openTransformationPicker`
     - Updated `transformClipboard` command to use new window API
   - Modified `apps/whispering/src/routes/+layout/AppShell.svelte`:
     - Removed `TransformationPickerDialog` import
     - Removed `<TransformationPickerDialog />` component instance

7. **Cleanup**
   - Deleted `apps/whispering/src/lib/components/TransformationPickerDialog.svelte`
   - Removed all always-on-top management code (now handled by Tauri window config)

### Deviations from Plan

**Minor simplifications**:
- Combined event setup with window management utility (simpler than initially planned separate phases)
- Window configuration uses slightly larger dimensions (700x600 instead of 600x500) for better UX
- Set `resizable: true` instead of `false` to give users more control

### Implementation Notes

**Key decisions**:
- Window label is a constant `WINDOW_LABEL = 'transformation-picker'` for easy reference
- Window instance is tracked in module-level variable for reuse
- Used `WebviewWindow.getByLabel()` to check for existing window before creating new one
- Emit event immediately after window creation/focus to ensure clipboard text is sent

**Code quality**:
- All TypeScript types are properly defined
- Error handling included for window creation failures
- Event listeners properly cleaned up on component unmount
- Window instance nullified on close/error

### Benefits Achieved

1. ✅ **Native window controls**: Users can now move, minimize, and manage the picker as a native window
2. ✅ **Always-on-top built-in**: No more manual always-on-top management; handled by Tauri
3. ✅ **Better multi-monitor support**: Window can be positioned anywhere
4. ✅ **Cleaner state management**: No more module-level Svelte state; uses Tauri window APIs
5. ✅ **Better resource management**: Window only exists when needed

### Testing Recommendations

To fully validate this implementation, test the following:

1. **Opening the picker**
   - Trigger the "Transform Clipboard" command with text in clipboard
   - Verify window opens and receives clipboard text
   - Verify window is always-on-top

2. **Transformation execution**
   - Select a transformation from the picker
   - Verify window closes
   - Verify transformation executes and result is delivered

3. **Window reuse**
   - Open picker, close it, open again
   - Verify window reuses existing instance if still open
   - Verify new window is created if previous was closed

4. **Edge cases**
   - Open picker with empty clipboard
   - Open picker while transformation is running
   - Close window while transformation is running

### Future Improvements

1. **Window position persistence**
   - Save window position between opens
   - Restore to last position or center on first open

2. **Keyboard shortcuts**
   - Add Escape key to close window
   - Add keyboard navigation for transformation selection

3. **Window state management**
   - Track window open/closed state globally
   - Prevent opening multiple instances

4. **Enhanced error handling**
   - Show user-friendly error if window creation fails
   - Fallback to inline dialog if Tauri APIs unavailable

5. **Window configuration**
   - Add user preferences for window size
   - Add option to remember window position

## Final Refinements (2025-10-28)

### Changes Made

1. **Toggle functionality**
   - Changed `openTransformationPicker()` to `toggleTransformationPicker()`
   - Implemented show/hide toggle: pressing shortcut once shows, pressing again hides
   - Added `isVisible()` check to determine whether to show or hide window
   - Updated command in `commands.ts` to use toggle function

2. **Show/Hide pattern instead of create/destroy**
   - Changed `closeTransformationPicker()` to `hideTransformationPicker()`
   - Window stays in memory when hidden (faster re-opening)
   - Window only created once, then toggled between visible/hidden states
   - Performance improvement: instant window showing after first creation

3. **Removed event system**
   - Deleted `apps/whispering/src/lib/tauri/events.ts` (no longer needed)
   - Window now reads clipboard directly using `rpc.text.readFromClipboard`
   - Simpler architecture: no inter-window message passing
   - More direct: clipboard reading happens on-demand when window opens

4. **Route organization with layout groups**
   - Created `(app)` layout group for main application
   - Moved `+layout.svelte` to `(app)/+layout.svelte` with AppLayout component
   - Moved `(config)` into `(app)/(config)` hierarchy
   - Created minimal root `+layout.svelte` with only essentials (QueryProvider, ModeWatcher)
   - `transformation-picker` route at root level (bypasses AppLayout to avoid permission issues)

5. **Component reorganization**
   - Renamed `AppShell.svelte` to `AppLayout.svelte`
   - Moved to `(app)/_components/AppLayout.svelte`
   - Moved `+layout/` folder to `(app)/_layout-utils/`
   - Fixed all broken imports across 5 files using proper paths

6. **Permissions configuration**
   - Created `capabilities/transformation-picker.json` with minimal permissions
   - Separated transformation picker permissions from main app
   - Added required permissions:
     - `core:window:allow-close`, `core:window:allow-hide`
     - `core:event:allow-emit`, `core:event:allow-listen`
     - `clipboard-manager:allow-read-text`
     - `notification:default` and related notification permissions

7. **Refactored to TanStack Query**
   - Changed `rpc.text.readFromClipboard` from `defineMutation` to `defineQuery`
   - Added `textKeys` constant for query key management
   - Updated transformation-picker page to use `createQuery` instead of `onMount()`
   - Added query options:
     - `refetchOnWindowFocus: true` - Refreshes clipboard when window gains focus
     - `refetchOnMount: true` - Ensures fresh data on mount
   - Replaced async/await pattern with reactive `$derived` state
   - Error handling via `$effect` watching `clipboardQuery.error` and `clipboardQuery.isSuccess`
   - Added loading state UI showing "Reading clipboard..." while query is pending

### Architecture Benefits

**From event system to direct clipboard reading**:
- Simpler: No event passing, no event types, no listeners
- More reliable: No risk of lost/missed events
- Better performance: Direct read, no serialization/deserialization
- Easier to debug: Straightforward function call, no async event flow

**From create/destroy to show/hide**:
- Instant re-opening: Window already in memory
- Better UX: No visible window creation delay
- Resource efficient: Window created once, reused indefinitely
- Natural toggle behavior: Press once to show, press again to hide

**From onMount to TanStack Query**:
- Automatic refetching: Fresh clipboard data when window refocuses
- Loading states: Built-in `isPending` for better UX
- Error states: Reactive error handling with `clipboardQuery.error`
- Consistency: Matches RPC pattern used throughout the app
- Caching: TanStack Query handles caching and deduplication

**Layout group hierarchy**:
- Clear separation: Root layout = essentials, (app) layout = app-specific features
- Permission isolation: transformation-picker bypasses app layout to avoid unnecessary permissions
- Better organization: Config routes nested in app group where they belong
- Easier maintenance: Layout changes affect only their group

### Final Implementation Summary

The transformation picker is now:
- ✅ A separate native Tauri window with native controls
- ✅ Toggleable via keyboard shortcut (show/hide pattern)
- ✅ Reads clipboard directly using TanStack Query with auto-refresh
- ✅ Uses minimal permissions via separate capability file
- ✅ Organized with proper SvelteKit layout groups
- ✅ Implements consistent RPC patterns matching rest of app
- ✅ Has proper loading states and error handling
- ✅ Instant re-opening after first creation (show/hide, not create/destroy)

### Key Files Modified (Final State)

- `apps/whispering/src/routes/+layout.svelte` - Minimal root layout
- `apps/whispering/src/routes/(app)/+layout.svelte` - App-specific layout with AppLayout
- `apps/whispering/src/routes/(app)/_components/AppLayout.svelte` - Renamed from AppShell
- `apps/whispering/src/routes/(app)/_layout-utils/` - Moved from `+layout/`
- `apps/whispering/src/routes/transformation-picker/+page.svelte` - Uses TanStack Query
- `apps/whispering/src/lib/tauri/transformationPickerWindow.ts` - Toggle and hide functions
- `apps/whispering/src/lib/query/text.ts` - Changed to defineQuery pattern
- `apps/whispering/src/lib/query/commands.ts` - Uses toggle function
- `apps/whispering/src-tauri/capabilities/transformation-picker.json` - Minimal permissions

### Deleted Files (Final State)

- `apps/whispering/src/lib/components/TransformationPickerDialog.svelte`
- `apps/whispering/src/lib/tauri/events.ts`
