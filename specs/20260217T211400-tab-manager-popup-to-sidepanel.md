# Tab Manager: Popup → Side Panel Migration

**Date**: 2026-02-17
**Status**: Draft
**Author**: AI-assisted
**Branch**: `feat/tab-manager-scrollarea`

## Overview

Replace the tab manager's popup entrypoint with a Chrome Side Panel (and Firefox sidebar) entrypoint. The extension icon click opens a persistent side panel instead of a fixed-size popup. This eliminates the scroll/layout constraints that come with popup's fixed dimensions and aligns with the industry-standard pattern for tab manager extensions.

## Motivation

### Current State

The tab manager renders as a browser action popup with hardcoded dimensions:

```svelte
<!-- App.svelte -->
<main class="w-200 h-150 overflow-hidden flex flex-col bg-background text-foreground">
```

The virtualized tab list has a hardcoded pixel height because Virtua needs explicit dimensions:

```svelte
<!-- FlatTabList.svelte -->
<VList data={flatItems} style="height: 600px;">
```

The popup entrypoint declares itself as a `browser_action`:

```html
<!-- popup/index.html -->
<meta name="manifest.type" content="browser_action" />
```

This creates problems:

1. **Fixed dimensions fight scroll behavior**: The `w-200 h-150` (800×600px) constraint means all scroll logic must negotiate with a rigid box. The current branch (`feat/tab-manager-scrollarea`) has been wrestling with ScrollArea + flex + Virtua interactions inside this fixed container.
2. **Virtua needs hardcoded pixel height**: VList requires an explicit height. In a popup, there's no parent with a natural height to inherit: the popup IS the viewport. So we hardcode `600px`, which is fragile and doesn't adapt.
3. **Popup closes on any outside click**: Users lose their place every time they click away. For a tab manager that you reference while browsing, this is poor UX.
4. **Non-standard pattern**: Every modern tab manager and AI assistant extension uses side panels. Popups are for quick actions (password fill, toggle), not persistent tools.

### Desired State

Click the extension icon → side panel opens in Chrome's native sidebar. The panel persists across tab navigation. Layout fills the sidebar naturally, no hardcoded dimensions. Scroll behavior just works.

```
┌─────────────────────────────────────────────────────┬──────────────┐
│                                                     │ Tab Manager  │
│                                                     │ ┌──────────┐ │
│              Browser Content Area                   │ │ Tabs │Saved│ │
│                                                     │ ├──────────┤ │
│                                                     │ │ Window 1  │ │
│                                                     │ │  Tab A    │ │
│                                                     │ │  Tab B    │ │
│                                                     │ │ Window 2  │ │
│                                                     │ │  Tab C    │ │
│                                                     │ │  ...      │ │
│                                                     │ └──────────┘ │
└─────────────────────────────────────────────────────┴──────────────┘
```

## Research Findings

### How AI/Tab Manager Extensions Handle Side Panels

Every modern extension in this category uses `openPanelOnActionClick: true` with no popup.

| Extension / Project                                 | Approach                                             | Framework    |
| --------------------------------------------------- | ---------------------------------------------------- | ------------ |
| Google Gemini samples                               | `openPanelOnActionClick: true`                       | Vanilla      |
| Uniswap Wallet                                      | `setPanelBehavior` + WXT `defineBackground`          | WXT          |
| Nanobrowser (AI agent)                              | `openPanelOnActionClick: true`                       | Custom       |
| Extension.js templates (React, Vue, **Svelte**, TS) | `openPanelOnActionClick: true` with Firefox fallback | Extension.js |
| Keplr Wallet                                        | Toggleable: `true`/`false` based on user preference | Custom       |

**Key finding**: No serious tab manager or AI extension uses a popup as its primary UI. The industry converged on side panels after Chrome 114 (mid-2023).

**Implication**: We're fighting an uphill battle with popup constraints when the platform has a purpose-built solution.

### WXT Side Panel Support

WXT handles side panel entrypoints automatically. Just create the file: WXT generates the correct manifest for each target browser.

| What WXT Does | Chrome MV3                                           | Firefox                                                   |
| ------------- | ---------------------------------------------------- | --------------------------------------------------------- |
| Manifest key  | `"side_panel": { "default_path": "sidepanel.html" }` | `"sidebar_action": { "default_panel": "sidepanel.html" }` |
| Permission    | Auto-adds `"sidePanel"`                              | Not needed                                                |
| API           | `chrome.sidePanel`                                   | `browser.sidebarAction` (no JS config needed)             |

**Entrypoint naming conventions** (all valid):

- `entrypoints/sidepanel.html`
- `entrypoints/sidepanel/index.html`
- `entrypoints/{name}.sidepanel.html`
- `entrypoints/{name}.sidepanel/index.html`

**Supported `<meta>` tags for sidepanel HTML**:

- `manifest.default_icon`: panel icon
- `manifest.open_at_install`: Firefox only, auto-open on install
- `manifest.browser_style`: Firefox only, deprecated
- `manifest.include` / `manifest.exclude`: browser targeting

**The gap WXT doesn't fill**: `setPanelBehavior({ openPanelOnActionClick: true })` is a runtime Chrome API call. You write this yourself in `background.ts`. WXT just handles the manifest.

### Popup + Side Panel Coexistence

WXT can generate both `action.default_popup` and `side_panel.default_path` in the same manifest. However:

- The extension icon click can only trigger ONE thing. If `openPanelOnActionClick: true`, the popup is bypassed.
- Having both adds complexity for no benefit in our case.
- Every reference extension drops the popup entirely.

**Key finding**: Don't keep both. Delete popup, go sidepanel-only.

### Virtua in a Side Panel Context

The current `VList` has `style="height: 600px"` because popups don't provide a natural parent height. In a side panel:

- The sidebar has a natural full height (100vh of the sidebar viewport)
- CSS `html, body { height: 100% }` + flexbox gives VList a real parent height to inherit
- Virtua's VList can use `style="height: 100%"` or wrap it in a flex container with `flex: 1; min-height: 0`

**Implication**: The hardcoded `600px` goes away. Virtua works naturally in a full-height container.

### CSS Height Chain for Side Panel

For `height: 100%` to propagate in a side panel, every ancestor must have a defined height:

```css
html,
body {
	height: 100%;
	margin: 0;
}
#app {
	height: 100%;
}
```

Then in Svelte:

```svelte
<main class="h-full flex flex-col">
	<!-- header -->
	<div class="flex-1 min-h-0">
		<!-- scrollable content fills remaining space -->
	</div>
</main>
```

### Browser Compatibility

| Feature           | Chrome             | Firefox             | Edge          | Safari        |
| ----------------- | ------------------ | ------------------- | ------------- | ------------- |
| Side Panel API    | ✅ 114+ (May 2023) | N/A                 | ✅ (Chromium) | ✅ (Chromium) |
| Sidebar Action    | N/A                | ✅ (all versions)   | N/A           | N/A           |
| WXT auto-handling | ✅ MV3 only        | ✅                  | ✅            | ✅            |
| MV2 support       | ❌                 | ✅ (sidebar_action) | ❌            | ❌            |

**Key finding**: Chrome < 114 is extremely unlikely to matter (2+ years old). Firefox uses a different API (`sidebar_action`) but WXT handles the abstraction.

## Design Decisions

| Decision                 | Choice                                                        | Rationale                                                                                                          |
| ------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Entrypoint type          | Side panel only, delete popup                                 | Industry standard. Popup adds no value for a tab manager.                                                          |
| Directory structure      | `entrypoints/sidepanel/index.html` + `main.ts` + `App.svelte` | Matches existing popup directory convention. WXT supports this pattern.                                            |
| `openPanelOnActionClick` | Set `true` unconditionally in `background.ts`                 | Every reference extension does this. No toggle needed initially.                                                   |
| Layout approach          | `html,body,#app { height: 100% }` + flexbox                   | Standard full-height pattern. Lets Virtua inherit natural height.                                                  |
| Fixed dimensions         | Remove entirely (`w-200 h-150` → `h-full w-full`)             | Side panel width is controlled by the browser. Height fills naturally.                                             |
| VList height             | Replace `600px` with flex container (`flex-1 min-h-0`)        | Parent has natural height now. No pixel guessing.                                                                  |
| ScrollArea               | Keep `ScrollArea.Root` wrapping tab content                   | Still useful for styled scrollbars. But it gets a natural height from flex parent instead of fighting a fixed box. |
| `workspace-popup.ts`     | Rename to `workspace-panel.ts` (or keep as-is)                | Deferred: cosmetic. File works identically regardless of entrypoint.                                              |
| Firefox handling         | Let WXT auto-generate `sidebar_action` manifest               | Zero custom code needed. WXT handles it.                                                                           |
| `app.css`                | Add `html, body, #app { height: 100% }`                       | Required for the CSS height chain. Current `app.css` has no body styles.                                           |
| `wxt.config.ts`          | No changes needed                                             | WXT auto-discovers sidepanel entrypoint and adds permissions/manifest keys.                                        |
| Background sync          | No changes                                                    | Background worker is entrypoint-agnostic. Sync logic unchanged.                                                    |

## Architecture

### Current Flow (Popup)

```
User clicks extension icon
         │
         ▼
┌──────────────────────────────────┐
│ Popup (800×600 fixed)            │
│                                  │
│  ┌─ ScrollArea ──────────────┐   │
│  │  ┌─ VList (600px fixed) ┐ │   │
│  │  │  Window headers      │ │   │
│  │  │  Tab items           │ │   │
│  │  └──────────────────────┘ │   │
│  └───────────────────────────┘   │
│                                  │
│  Closes on any outside click     │
└──────────────────────────────────┘
```

### New Flow (Side Panel)

```
User clicks extension icon
         │
         ▼
setPanelBehavior({ openPanelOnActionClick: true })
         │
         ▼
┌──────────────────────────────────┐
│ Side Panel (browser-controlled)  │
│ Height: 100vh of sidebar         │
│ Width: ~400px (user-resizable)   │
│                                  │
│  html, body, #app { h: 100% }   │
│  ┌─ main (h-full flex-col) ──┐  │
│  │  header (sticky)           │  │
│  │  ┌─ ScrollArea (flex-1) ─┐ │  │
│  │  │  ┌─ VList (h-full) ─┐ │ │  │
│  │  │  │  Window headers   │ │ │  │
│  │  │  │  Tab items        │ │ │  │
│  │  │  └──────────────────┘ │ │  │
│  │  └───────────────────────┘ │  │
│  └────────────────────────────┘  │
│                                  │
│  Persists across tab navigation  │
└──────────────────────────────────┘
```

### What Changes vs What Doesn't

```
CHANGES                              NO CHANGES
───────                              ──────────
entrypoints/popup/ → DELETE          entrypoints/background.ts (+ 3 lines)
entrypoints/sidepanel/ → CREATE      lib/state/browser-state.svelte.ts
  index.html (new, no browser_action)  lib/state/saved-tab-state.svelte.ts
  main.ts (copy from popup)          lib/workspace-popup.ts
  App.svelte (remove fixed dims)     lib/components/TabItem.svelte
app.css (add height chain)           lib/components/SavedTabList.svelte
FlatTabList.svelte (flex height)     lib/workspace.ts
                                     wxt.config.ts (auto-discovery)
                                     package.json (no new deps)
```

## Implementation Plan

### Phase 1: Create Side Panel Entrypoint

- [ ] **1.1** Create `src/entrypoints/sidepanel/index.html`:
  - Standard HTML5 boilerplate
  - `<title>Tab Manager</title>`
  - NO `manifest.type` meta tag (not needed for sidepanel: WXT infers from directory name)
  - Same icon meta tag as current popup: `<meta name="manifest.default_icon" content='{ "16": "icon-16.png", "48": "icon-48.png", "128": "icon-128.png" }' />`
  - `<div id="app"></div>` + `<script type="module" src="./main.ts"></script>`

- [ ] **1.2** Create `src/entrypoints/sidepanel/main.ts`:
  - Copy from `popup/main.ts`: identical content
  - Mounts `App.svelte` into `#app`

- [ ] **1.3** Create `src/entrypoints/sidepanel/App.svelte`:
  - Copy from `popup/App.svelte`
  - Replace `class="w-200 h-150 overflow-hidden flex flex-col"` with `class="h-full w-full overflow-hidden flex flex-col"`
  - Everything else stays the same (Tabs, ScrollArea, header, etc.)

### Phase 2: Update Layout for Full-Height

- [ ] **2.1** Update `src/app.css`:
  - Add height chain: `html, body, #app { height: 100%; margin: 0; padding: 0; }`
  - Update comment from "Extension popup specific styles" to "Extension side panel styles"

- [ ] **2.2** Update `FlatTabList.svelte`:
  - Replace `style="height: 600px;"` on VList with `class="flex-1 min-h-0 h-full"` (or `style="height: 100%"`)
  - Ensure VList's parent container provides height via flexbox
  - Note: May need to wrap VList in a `div` with `class="flex-1 min-h-0"` if VList doesn't accept class prop: test this

- [ ] **2.3** Ensure ScrollArea fills flex space:
  - `ScrollArea.Root` already has `class="flex-1 min-h-0 w-full"`: verify this works in full-height context

### Phase 3: Wire Up Background

- [ ] **3.1** Add `setPanelBehavior` call to `src/entrypoints/background.ts`:
  - Add at the top of the `defineBackground` callback, before any other logic
  - Use the WXT `browser` global (which maps to `chrome` on Chrome):
    ```typescript
    browser.sidePanel
	.setPanelBehavior({ openPanelOnActionClick: true })
	.catch((error: unknown) => console.error(error));
    ```
  - Note: WXT's polyfill `browser` may not have `sidePanel` typed. If so, use `chrome.sidePanel` directly with a Chrome guard (`if (import.meta.env.CHROME)`): Firefox doesn't need this call (sidebar opens via its own UI).

### Phase 4: Delete Popup Entrypoint

- [ ] **4.1** Delete `src/entrypoints/popup/` directory entirely:
  - `popup/index.html`
  - `popup/main.ts`
  - `popup/App.svelte`

### Phase 5: Verify

- [ ] **5.1** Type check passes (`bun run --filter @epicenter/tab-manager typecheck`)
- [ ] **5.2** Extension builds successfully (`bun run --filter @epicenter/tab-manager build`)
- [ ] **5.3** Load extension in Chrome → click icon → side panel opens (not popup)
- [ ] **5.4** Side panel persists when navigating between tabs
- [ ] **5.5** Tab list renders correctly with natural scroll (no hardcoded heights)
- [ ] **5.6** All tab actions work (close, pin, mute, reload, duplicate, save)
- [ ] **5.7** Saved tabs tab works
- [ ] **5.8** Build for Firefox (`bun run --filter @epicenter/tab-manager build:firefox`): verify manifest has `sidebar_action`

## Edge Cases

### `browser.sidePanel` Not Available

1. Firefox doesn't have `chrome.sidePanel` API
2. Background script calls `browser.sidePanel.setPanelBehavior()`
3. Call throws

**Resolution**: Guard with `if (import.meta.env.CHROME)` or catch the error (already wrapped in `.catch()`). Firefox uses `sidebar_action` manifest key: no runtime API call needed.

### VList Height in Narrow Sidebar

1. User resizes Chrome sidebar to very narrow width (~250px)
2. Tab items may wrap or overflow

**Resolution**: Current `TabItem` already uses `truncate` on text. The sidebar has a browser-enforced minimum width (~300px). Test at minimum width during verification.

### First Install Behavior

1. User installs extension for the first time
2. Chrome shows the extension icon but user may not know to click it

**Resolution**: Chrome shows a brief animation on the extension icon after install. For Firefox, consider setting `open_at_install: true` meta tag so the sidebar auto-opens.

### Side Panel vs Popup Mental Model

1. Users accustomed to popup behavior (click icon → small window)
2. Side panel is a different interaction pattern

**Resolution**: Side panel is strictly better UX for this use case. No action needed: users adapt quickly.

### Existing Popup Users After Update

1. User has old version with popup
2. Extension updates to sidepanel-only version
3. User clicks icon expecting popup

**Resolution**: Chrome handles this gracefully. The `onInstalled` listener already fires on update. The manifest change takes effect immediately. Side panel opens instead of popup.

## Open Questions

1. **Should we add `open_at_install: true` for Firefox?**
   - Pro: User immediately sees the sidebar after install
   - Con: Could be annoying if they don't expect it
   - **Recommendation**: Set `true`: matches other sidebar extensions and gives immediate value

2. **Should we rename `workspace-popup.ts` to `workspace-panel.ts`?**
   - It's referenced by `browser-state.svelte.ts` and `saved-tab-state.svelte.ts`
   - Purely cosmetic rename
   - **Recommendation**: Defer: not worth the diff noise in this PR. Can rename later.

3. **Should we keep the `@source` glob in `app.css` as-is?**
   - Currently: `@source "./entrypoints/**/*.{svelte,ts}";`
   - This will pick up `sidepanel/` automatically
   - **Recommendation**: Keep as-is: the glob already covers the new directory.

4. **How should VList receive its height: `style="height: 100%"` or flex?**
   - Virtua's `VList` accepts a `style` prop directly
   - Option A: `style="height: 100%"` with a parent that has explicit height
   - Option B: Wrap in `<div class="flex-1 min-h-0">` and let VList fill it
   - **Recommendation**: Try Option A first (simpler). Fall back to Option B if Virtua doesn't respect percentage heights.

5. **Should we add a keyboard shortcut to toggle the side panel?**
   - Chrome supports `_execute_side_panel` command in manifest
   - Would need to add to `wxt.config.ts` manifest commands
   - **Recommendation**: Defer: nice to have, not needed for MVP migration.

## Success Criteria

- [ ] Extension icon click opens Chrome side panel (not popup)
- [ ] Side panel persists across tab navigation
- [ ] Tab list fills the full sidebar height with natural scrolling
- [ ] No hardcoded pixel dimensions in any component
- [ ] All existing functionality works (tab actions, saved tabs, Yjs sync)
- [ ] Firefox build produces `sidebar_action` manifest entry
- [ ] Type check and build pass
- [ ] No popup entrypoint remains

## Review

### Changes Made

| File | Change |
| --- | --- |
| `src/entrypoints/sidepanel/index.html` | **Created.** Standard HTML5 boilerplate, no `manifest.type` meta tag (WXT infers from directory name), same icon meta as former popup. |
| `src/entrypoints/sidepanel/main.ts` | **Created.** Identical to former `popup/main.ts`: mounts App into `#app`. |
| `src/entrypoints/sidepanel/App.svelte` | **Created.** Copied from `popup/App.svelte`, replaced `w-200 h-150` with `h-full w-full`. All component imports and logic identical. |
| `src/entrypoints/background.ts` | **Modified.** Added `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` behind `import.meta.env.CHROME` guard at the top of `defineBackground` callback. |
| `src/app.css` | **Modified.** Added `html, body, #app { height: 100%; margin: 0; padding: 0; }` for the full-height CSS chain. |
| `src/lib/components/FlatTabList.svelte` | **Modified.** Changed VList from `style="height: 600px;"` to `style="height: 100%;"`. Removed the `<!-- VList needs explicit pixel height -->` comment. |
| `src/entrypoints/popup/` | **Deleted.** Entire directory (`index.html`, `main.ts`, `App.svelte`). |

### Verification Results

- **Chrome build**: ✅ Exit code 0. Manifest contains `"side_panel": { "default_path": "sidepanel.html" }` and `"sidePanel"` permission. No popup entry.
- **Firefox build**: ✅ Exit code 0. Manifest contains `"sidebar_action": { "default_panel": "sidepanel.html" }`. No popup entry.
- **Typecheck**: ✅ 37 pre-existing errors in `packages/ui` (unrelated `#/utils.js` import resolution). Zero new errors from our changes.
- **LSP diagnostics**: ✅ Clean on all 4 modified/created files.

### Implementation Notes

1. **`chrome.sidePanel` typing**: WXT's `browser` polyfill doesn't expose `sidePanel`. Used `globalThis` cast to access the Chrome API directly, keeping it type-safe without adding dependencies.
2. **VList height strategy**: Went with `style="height: 100%"` (Option A from spec) since the CSS height chain (`html → body → #app → main → ScrollArea.Root`) provides explicit heights at every level. If scroll issues arise during manual testing, the fallback is wrapping VList in a `<div class="flex-1 min-h-0">`.
3. **ScrollArea retained**: Kept `ScrollArea.Root` wrapping both tab content panels. VList handles its own virtual scroll for the windows tab; ScrollArea provides styled scrollbars for the non-virtualized SavedTabList tab.

### Open Items Resolved

- **Open Question #1 (open_at_install for Firefox)**: Not set. Can be added later via meta tag.
- **Open Question #2 (rename workspace-popup.ts)**: Deferred as spec recommended.
- **Open Question #3 (@source glob)**: Kept as-is: glob already covers `sidepanel/`.
- **Open Question #4 (VList height approach)**: Used Option A (`style="height: 100%"`).
- **Open Question #5 (keyboard shortcut)**: Deferred as spec recommended.

### Manual Testing Needed

- [ ] Load extension in Chrome → click icon → side panel opens (not popup)
- [ ] Side panel persists when navigating between tabs
- [ ] Tab list renders correctly with natural scroll
- [ ] All tab actions work (close, pin, mute, reload, duplicate, save)
- [ ] Saved tabs tab works
- [ ] Narrow sidebar width (~300px) renders correctly

## References

- `apps/tab-manager/src/entrypoints/popup/`: Current popup entrypoint (to be deleted)
- `apps/tab-manager/src/entrypoints/background.ts`: Add `setPanelBehavior` call
- `apps/tab-manager/src/entrypoints/popup/App.svelte`: Layout to adapt (remove fixed dims)
- `apps/tab-manager/src/lib/components/FlatTabList.svelte`: Remove hardcoded `600px`
- `apps/tab-manager/src/app.css`: Add height chain
- `apps/tab-manager/wxt.config.ts`: No changes needed (WXT auto-discovers)
- `apps/tab-manager/src/lib/workspace-popup.ts`: Works unchanged, optional rename later
- Uniswap Extension (`Uniswap/interface`): WXT + sidepanel reference implementation
- Extension.js Svelte template: `openPanelOnActionClick` pattern with Firefox fallback
- `specs/20260213T015500-popup-reactive-state.md`: Previous spec (reactive state, already implemented)
