# Simplify Vertical Nav PR Analysis

## Current State

PR #1073 adds a vertical navigation layout with a sidebar. The current state shows:

1. **`(app)/+layout.svelte` already integrates VerticalNav** as the default layout (the PR already made this change)
2. **`verticalnav/` routes are redundant** because the main routes now work with the sidebar layout
3. The `verticalnav/` directory appears to be leftover from a transitional approach and can be deleted

## What the PR Already Did Right

The `(app)/+layout.svelte` now wraps everything in the sidebar provider:

```svelte
<Sidebar.Provider>
  <VerticalNav {getRecorderStateQuery} {getVadStateQuery} />
  <Sidebar.Inset>
    <AppLayout>
      {@render children()}
    </AppLayout>
  </Sidebar.Inset>
</Sidebar.Provider>
```

This means existing routes (`/recordings`, `/settings`, etc.) already work with the vertical nav; **no duplicate routes needed**.

## What Can Be Deleted

### Entire `verticalnav/` Directory (DELETE ALL)

Since the vertical nav is now integrated at the `(app)/+layout.svelte` level, the entire `verticalnav/` directory is redundant:

```
apps/whispering/src/routes/(app)/verticalnav/   # DELETE ENTIRE DIRECTORY
├── +layout.svelte                              # Duplicates (app)/+layout.svelte
├── +layout/VerticalNav.svelte                  # Move to _components/
├── +page.svelte                                # Duplicates (app)/+page.svelte
├── desktop-app/                                # Wrapper to (config)/desktop-app
├── global-shortcut/                            # Wrapper
├── install-ffmpeg/                             # Duplicates existing
├── macos-enable-accessibility/                 # Duplicates existing
├── recordings/                                 # Wrapper to (config)/recordings
├── transformations/                            # Wrapper to (config)/transformations
└── settings/                                   # Duplicates (config)/settings structure
    ├── +layout.svelte
    ├── +page.svelte
    ├── SidebarNav.svelte                       # Has /verticalnav hardcoded paths
    ├── analytics/
    ├── api-keys/
    ├── recording/                              # 344 lines duplicating existing
    ├── shortcuts/
    ├── sound/
    └── transcription/
```

### NavItems `pathPrefix` Prop (REMOVE)

The `pathPrefix` prop was added to support `/verticalnav` routes. Since we're deleting those routes, revert `NavItems.svelte` to not use `pathPrefix`.

## What to Keep

### Keep: Move VerticalNav.svelte to `_components/`

The `VerticalNav.svelte` component should be moved from `verticalnav/+layout/` to `_components/`:

```
apps/whispering/src/routes/(app)/_components/VerticalNav.svelte
```

### Keep: packages/ui/sidebar Components

All the sidebar components in `packages/ui/src/sidebar/` are needed:

```
packages/ui/src/sidebar/
├── constants.ts
├── context.svelte.ts
├── index.ts
├── sidebar-*.svelte (all component files)
```

### Keep: packages/ui/sheet Components

The sheet components are used by sidebar on mobile:

```
packages/ui/src/sheet/
├── index.ts
├── sheet-*.svelte (all component files)
```

### Keep: Selector Component Enhancements

The props added to selectors (`unstyled`, `side`, `align`, `showLabel`) are useful for the sidebar:

- `CompressionSelector.svelte`
- `ManualDeviceSelector.svelte`
- `TranscriptionSelector.svelte`
- `TransformationSelector.svelte`
- `VadDeviceSelector.svelte`

### Keep: New Components

- `ManualRecordingButton.svelte`
- `VadRecordingButton.svelte`
- `EpicenterLogo.svelte`
- `is-mobile.svelte.ts` hook

## Summary of Changes

| Action | Files/Directories |
|--------|-------------------|
| DELETE | `apps/whispering/src/routes/(app)/verticalnav/` (entire directory) |
| MOVE | `verticalnav/+layout/VerticalNav.svelte` → `_components/VerticalNav.svelte` |
| REVERT | `NavItems.svelte` pathPrefix prop changes |
| KEEP | `(app)/+layout.svelte` changes (sidebar integration) |
| KEEP | `packages/ui/sidebar/*` |
| KEEP | `packages/ui/sheet/*` |
| KEEP | Selector component prop additions |
| KEEP | Recording button components |

## Todo

- [x] Move `VerticalNav.svelte` to `_components/`
- [x] Update import in `(app)/+layout.svelte` to use new location
- [x] Delete entire `verticalnav/` directory
- [x] Revert `NavItems.svelte` to remove `pathPrefix` prop
- [ ] Test that existing routes (`/recordings`, `/settings/*`, etc.) work correctly
- [ ] Verify sidebar toggle works on mobile

## Recording Section Removal (Additional Simplification)

### What Was Removed

The Recording section in VerticalNav was removed since recording controls are available on the home page. This included:

1. **Recording Group section** (VadRecordingButton, ManualRecordingButton, Cancel Recording button)
2. **Props**: `getRecorderStateQuery`, `getVadStateQuery` (no longer needed)
3. **Unused imports**:
   - `ManualRecordingButton`
   - `VadRecordingButton`
   - `commandCallbacks`
   - `CreateQueryResult` type

### Changes to +layout.svelte

- Removed `createQuery` import (no longer needed)
- Removed `getRecorderStateQuery` and `getVadStateQuery` query creation
- Simplified `<VerticalNav />` to have no props

### isActive Logic Improvement

Changed from:
```typescript
const isActive = (href: string, exact: boolean = false) => {
    if (exact) {
        return page.url.pathname === href;
    }
    return page.url.pathname.startsWith(href);
};
```

To safer implementation:
```typescript
const isActive = (href: string, exact = false) => {
    const pathname = page.url.pathname;
    if (exact) return pathname === href;
    return pathname === href || pathname.startsWith(`${href}/`);
};
```

This prevents `/recordings` from incorrectly matching `/recordingsXYZ` while still correctly matching `/recordings/123`.
