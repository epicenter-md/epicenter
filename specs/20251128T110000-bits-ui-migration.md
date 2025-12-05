# Bits-UI Migration Specification

## Overview

This document provides a comprehensive handoff for migrating from bits-ui 2.8.10 to 2.14.4.

**Current version**: 2.8.10
**Target version**: 2.14.4

## Why Update?

bits-ui 2.14.4 includes:
- Bug fixes for ContextMenu, Calendar, Tooltip, Select, Combobox
- New features like `onOpenChangeComplete` prop
- `readonly` prop for Checkbox/CheckboxGroup
- `hiddenUntilFound` prop for Collapsible/Accordion
- Stabilized `RatingGroup` component
- Better nested dialog styling

## Known Issues

The upgrade causes **19 type errors** in `packages/ui` related to `exactOptionalPropertyTypes: true` in tsconfig. These are TypeScript strict mode compatibility issues, not runtime bugs.

## Breaking Changes

### 1. Slider.Root Requires `type` Prop (REQUIRED FIX)

```svelte
<!-- Before (bits-ui 2.8) -->
<Slider.Root value={50} />

<!-- After (bits-ui 2.14) -->
<Slider.Root type="single" value={50} />
<!-- or for multiple thumbs -->
<Slider.Root type="multiple" value={[25, 75]} />
```

### 2. RatingGroup Prefix Removed

```svelte
<!-- Before -->
<unstable_RatingGroup.Root />

<!-- After -->
<RatingGroup.Root />
```

## Type Compatibility Issues

The main blocker is `exactOptionalPropertyTypes: true` in tsconfig. bits-ui 2.14 has stricter types that conflict with this setting.

### Affected Components (19 errors)

| File | Issue |
|------|-------|
| `command-dialog.svelte` | `portalProps` type mismatch |
| `command-group.svelte` | `children` snippet type |
| `copy-button/types.ts` | Missing `ButtonPropsWithoutHTML` export |
| `copy-button.svelte` | Union type too complex |
| `dropdown-menu-radio-group.svelte` | Union type too complex |
| `popover-content.svelte` | Optional prop types |
| `progress.svelte` | `value` type mismatch |
| `snippet.svelte` | Missing required props |
| `sonner.svelte` | `theme` type mismatch |

### Root Cause

The errors follow a pattern:
```
Type 'X | undefined' is not assignable to type 'X'.
Type 'undefined' is not assignable to type 'X'.
```

This happens because `exactOptionalPropertyTypes` requires explicit `undefined` in union types for optional props, but bits-ui's types don't include `undefined` in the union.

## Migration Options

### Option A: Fix Component Types (Recommended)

Update each affected component to handle the type issues:

1. **For optional props passed through**, use nullish coalescing or conditionals:
```svelte
<!-- Before -->
<Dialog.Content {portalProps}>

<!-- After -->
{#if portalProps}
  <Dialog.Content {portalProps}>
{:else}
  <Dialog.Content>
{/if}

<!-- Or use spread with filtering -->
<Dialog.Content {...(portalProps ? { portalProps } : {})}>
```

2. **For children snippets**, ensure they're always defined or use conditionals.

3. **For theme props**, cast or provide defaults:
```svelte
<Sonner theme={mode.current ?? 'system'} />
```

### Option B: Disable exactOptionalPropertyTypes

In `tsconfig.json`:
```json
{
  "compilerOptions": {
    "exactOptionalPropertyTypes": false
  }
}
```

**Not recommended** as it reduces type safety across the entire codebase.

### Option C: Type Assertions (Last Resort)

Use `as` casts to bypass type checking:
```svelte
<Dialog.Content portalProps={portalProps as PortalProps}>
```

**Not recommended** as it hides potential runtime issues.

## Migration Tasks

### Step 1: Update Catalog Version

In root `package.json`:
```json
"bits-ui": "2.14.4"
```

### Step 2: Find All Slider Components

```bash
grep -r "Slider.Root" --include="*.svelte" .
```

Add `type="single"` or `type="multiple"` to each.

### Step 3: Fix Type Errors

For each of the 19 errors, apply Option A fixes.

#### command-dialog.svelte
```svelte
<!-- Fix portalProps -->
<Dialog.Content
  class="overflow-hidden p-0"
  {...(portalProps ? { portalProps } : {})}
>
```

#### command-group.svelte
```svelte
<!-- Ensure children is always provided -->
{#if children}
  <CommandPrimitive.GroupItems {children} />
{/if}
```

#### copy-button/types.ts
```typescript
// Check if ButtonPropsWithoutHTML export exists
// May need to update import or create local type
```

#### sonner.svelte
```svelte
<!-- Provide fallback for theme -->
<Sonner theme={mode.current ?? 'system'} />
```

#### progress.svelte
```svelte
<!-- Ensure value is not undefined -->
<ProgressPrimitive.Root value={value ?? 0} />
```

### Step 4: Run Type Check

```bash
cd packages/ui && bun run check
```

Fix any remaining errors.

### Step 5: Visual Testing

Test these components manually:
- Command palette (CommandDialog)
- Dropdown menus
- Progress bars
- Sliders (if any)
- Toast notifications (Sonner)
- Copy buttons
- Popovers

## Files to Modify

| File | Changes Needed |
|------|----------------|
| `packages/ui/src/command/command-dialog.svelte` | Fix portalProps |
| `packages/ui/src/command/command-group.svelte` | Fix children |
| `packages/ui/src/copy-button/types.ts` | Fix ButtonPropsWithoutHTML |
| `packages/ui/src/copy-button/copy-button.svelte` | Fix props spreading |
| `packages/ui/src/dropdown-menu/dropdown-menu-radio-group.svelte` | Fix props |
| `packages/ui/src/popover/popover-content.svelte` | Fix optional props |
| `packages/ui/src/progress/progress.svelte` | Fix value prop |
| `packages/ui/src/snippet/snippet.svelte` | Fix CopyButton props |
| `packages/ui/src/sonner/sonner.svelte` | Fix theme prop |

## New Features Available After Migration

Once migrated, you can use:

1. **`onOpenChangeComplete`** - Callback after animations finish
```svelte
<Dialog.Root onOpenChangeComplete={() => console.log('Animation done')}>
```

2. **`readonly` prop** - For Checkbox/CheckboxGroup
```svelte
<Checkbox readonly />
```

3. **`hiddenUntilFound`** - Expand on browser search match
```svelte
<Collapsible.Root hiddenUntilFound>
```

4. **Stable `RatingGroup`** - No longer unstable
```svelte
<RatingGroup.Root value={4} max={5} />
```

## Resources

- [bits-ui Changelog](https://github.com/huntabyte/bits-ui/releases)
- [bits-ui Migration Guide](https://bits-ui.com/docs/migration)

## Timeline Estimate

- **Fix type errors**: 2-4 hours
- **Visual testing**: 1-2 hours
- **Total**: 3-6 hours

The complexity depends on how many components actively use the affected patterns.

## Review Notes

### Migration Completed

The bits-ui migration from 2.8.10 to 2.14.4 was successfully completed with all 19 type errors fixed.

### Files Modified

| File | Fix Applied |
|------|-------------|
| `package.json` | Updated catalog version from `2.8.10` to `2.14.4` |
| `packages/ui/src/button/button.svelte` | Added `ButtonPropsWithoutHTML` type export |
| `packages/ui/src/button/index.ts` | Exported new `ButtonPropsWithoutHTML` type |
| `packages/ui/src/command/command-dialog.svelte` | Used conditional spread for `portalProps`: `{...(portalProps ? { portalProps } : {})}` |
| `packages/ui/src/command/command-group.svelte` | Wrapped `GroupItems` in `{#if children}` conditional |
| `packages/ui/src/copy-button/types.ts` | Simplified types to avoid bits-ui's `WithChildren`/`WithoutChildren` complexity |
| `packages/ui/src/copy-button/copy-button.svelte` | Cast rest props as `ButtonProps` to avoid union type complexity |
| `packages/ui/src/dropdown-menu/dropdown-menu-radio-group.svelte` | Set default value to empty string: `value = $bindable('')` |
| `packages/ui/src/dropdown-menu/index.ts` | Added explicit type annotations for `Root` and `Sub` exports |
| `packages/ui/src/file-drop-zone/file-drop-zone.svelte` | Added guard `if (!file) continue;` for array access |
| `packages/ui/src/modal/modal-content.svelte` | Renamed `hideClose` to `showCloseButton` to match Dialog.Content API |
| `packages/ui/src/popover/popover-content.svelte` | Used nullish coalescing: `{...(portalProps ?? {})}` |
| `packages/ui/src/progress/progress.svelte` | Used nullish coalescing: `value={value ?? null}` |
| `packages/ui/src/snippet/snippet.svelte` | Added explicit `size="icon"` and `variant="ghost"` props to CopyButton |
| `packages/ui/src/sonner/sonner.svelte` | Added fallback: `theme={mode.current ?? 'system'}` |

### Patterns Used

1. **Conditional prop spreading**: `{...(prop ? { prop } : {})}` for optional props
2. **Nullish coalescing**: `prop ?? fallback` for props that can be undefined
3. **Type assertions**: `{...(rest as ButtonProps)}` for complex union types
4. **Explicit type annotations**: `const Root: typeof X.Root = X.Root` for internal type references
5. **Guard clauses**: `if (!item) continue;` for potentially undefined array access

### Slider.Root Changes

No Slider components found in the codebase, so no changes were needed for the new `type` prop requirement.

### Unrelated Issues

The `@epicenter/db` package has a pre-existing error unrelated to bits-ui:
```
Module '"better-auth/crypto"' has no exported member 'hashToBase64'.
```
This is a separate issue with the better-auth dependency and should be addressed in a different PR.
