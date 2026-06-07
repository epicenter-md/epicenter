# Matter Grid Keyboard Navigation (two-mode data grid)

**Date**: 2026-06-06
**Status**: Draft
**Owner**: Braden (Matter)
**Branch**: matter-typed-markdown-editor
**Related**: clearing affordance commits `40af9e69a`, `8ab5b6887` (the eraser this spec demotes to mouse sugar)

## One Sentence

Turn the Matter modeled grid from a wall of independently tabbable cell widgets into a proper WAI-ARIA `grid` with a single tab stop, arrow-key cell navigation, and a navigate/edit two-mode model, so clearing a cell becomes Delete/Backspace on the selected cell and the per-cell eraser button becomes optional mouse sugar.

## How to read this spec

```
Read first:
  One Sentence
  Motivation (Current State, Problems, Desired State)
  Target Architecture
  Implementation Plan (Phase 1)
  Verification / Success Criteria

Read if changing the architecture:
  Research Findings (bits-ui + WAI-ARIA grounding)
  Design Decisions
  The widget interaction catalog
  Call sites (before / after)
  Edge Cases
  Open Questions

Skip unless relevant:
  Adjacent Work, Decisions Log, References
```

## Overview

The grid currently makes every cell's interactive control (text display button, checkbox, Select trigger, tags input) independently tabbable, so there is no notion of a "selected" cell, Tab walks hundreds of controls, and clearing is only reachable through an eraser button. This spec adds a grid-level selection and navigation layer (the spreadsheet interaction model: one tab stop, arrow keys move between cells, Enter/F2 enters a cell, Escape leaves it, Delete clears it) on top of the existing per-kind widgets, without changing the data semantics.

## Motivation

### Current State

The modeled grid renders each row as a `<Table.Row>` of `<Table.Cell>` wrappers, each holding a `ModeledCell` that dispatches to a per-kind widget (`apps/matter/src/lib/components/FolderGrid.svelte:335`):

```svelte
{#each conf.cells as cell (cell.field.name)}
  <Table.Cell
    aria-invalid={cell.state === 'INVALID' || cell.state === 'NEEDS_VALUE'}
    class={[alignClass(cell.field.kind), cellStateClass(cell.state)]}
  >
    <ModeledCell
      {cell}
      mode="grid"
      save={(value) => onSaveField(conf.row.name, cell.field.name, value)}
      clear={() => onSaveField(conf.row.name, cell.field.name, undefined)}
    />
  </Table.Cell>
{/each}
```

Each widget owns its own editing lifecycle and its own focusable control:

```
string / integer / number / datetime  -> TextCell: a <button> display, click -> <input>   (createCellEdit)
url                                    -> <a> link + pencil <Button>                         (createCellEdit)
boolean                                -> bits-ui <Checkbox>                                  (toggles on Space)
select / multiSelect                   -> bits-ui <Select> trigger + popover                  (opens on Arrow/Enter)
tags                                   -> always-on <input> + chip <Badge>s with X            (Enter appends, Backspace pops)
INVALID (any kind)                     -> JsonRepairEditor: a <button> display, click -> <input>
```

Clearing a field is the eraser `Button` inside `ModeledCell` (`apps/matter/src/lib/components/ModeledCell.svelte`), reachable by mouse and by Tab.

This creates problems:

1. **No single tab stop.** Every cell control is in the page tab sequence. A 40 row by 9 field grid is up to ~360 tab stops plus the eraser per filled cell. Tabbing to anything past the grid is punishing, and there is no way to move cell to cell with arrows.

2. **No selected-cell concept, so no spreadsheet keystrokes.** You cannot select a cell and press Delete to clear it (the conclusion of the prior clearing-affordance discussion). The eraser button is the only clear path, which is why it had to be visible at all (hover-reveal was rejected for exactly this reason).

3. **Inconsistent keyboard semantics across kinds.** Tabbing into a Select trigger lets Arrow keys open the menu; tabbing into a tags input captures every keystroke; tabbing into a text display button does nothing until Enter. There is no shared "I am on this cell, now I act on it" model.

4. **`opacity-0` is not hidden (already learned).** The hover-reveal eraser was always in the tab order and the a11y tree, so hiding it visually only helped sighted mouse users. The real fix is to stop relying on a per-cell button as the keyboard clear path at all.

### Desired State

The modeled grid behaves like Google Sheets / Airtable / Excel:

```
Tab into the grid          -> lands on one cell (roving tabindex), the rest are tabindex=-1
Arrow keys                 -> move the selected cell (no wrap at edges)
Home / End                 -> first / last cell in row
Ctrl+Home / Ctrl+End       -> first cell of first row / last cell of last row
PageUp / PageDown          -> move by a page of rows
Enter or F2 or a character -> enter EDIT mode on the selected cell (focus moves into the widget)
Escape                     -> leave edit mode, focus returns to the cell (NAVIGATE mode)
Delete / Backspace         -> clear the selected cell (only in navigate mode), via onSaveField(..., undefined)
Tab (navigate mode)        -> leave the grid entirely (one tab stop in, one out)
```

The per-cell eraser stays for mouse users (a discoverable click target) but is removed from the tab order; keyboard users clear with Delete. The data contract is unchanged: clear still deletes the key, never writes `null`.

## Research Findings

### WAI-ARIA Authoring Practices: the grid pattern (verified via `w3c/aria-practices`)

The data grid pattern is a two-mode composite widget:

| Mode | Focus is on | Arrow keys | How you got here |
| --- | --- | --- | --- |
| Navigate | the gridcell (or a non-arrow widget inside it) | move cell to cell | default; Escape from edit |
| Edit / interact | a widget inside the cell | belong to the widget | Enter / F2 / alphanumeric |

Key rules confirmed:

- **Roving tabindex**: exactly one element in the grid has `tabindex="0"`; all others are `tabindex="-1"`. Arrows move focus and swap the `0`.
- **No edge wrap**: arrows stop at the grid boundary.
- **Focus target by content** (this is the crux for our heterogeneous widgets):
  - Cell with text or a single graphic: focus the **cell**.
  - Cell with a single widget that does NOT need arrow keys (button, **checkbox**): focus the **widget** directly.
  - Cell with editable text, multiple widgets, or a widget that **uses arrow keys** (combobox / Select): stay on the cell in navigate mode; Enter / F2 / alphanumeric enters edit mode and moves focus into the widget; Escape returns to the cell.
- **Keymap**: Arrows, PageUp/Down, Home/End, Ctrl+Home/End for navigation; Enter/F2/alphanumeric to edit; Escape to exit (and may revert); Tab moves out of the grid in navigate mode, and to the next/previous widget when in edit mode.

### bits-ui keyboard behavior (verified via `huntabyte/bits-ui`)

This determines per-kind handling, because our composites fight grid arrows:

| Component | Keys it intercepts when its element is focused | Implication for the grid |
| --- | --- | --- |
| `Checkbox` | `Space` toggles; `Enter` only submits if `type="submit"` (it is not here). Does NOT intercept arrows. | Safe to focus the checkbox directly in navigate mode (APG "non-arrow widget"); Arrows still navigate; Space toggles; Delete clears. |
| `Select` (trigger) | `Enter`, `Space`, `ArrowDown`, `ArrowUp` OPEN the menu; typeahead on printable keys. | NOT safe in navigate mode (arrows would open it). Must be entered via edit mode: focus the trigger only after Enter/F2. `open` is bindable; `triggerNode.focus()` is available for programmatic focus return. |

**Key finding**: the two-mode model is not optional polish, it is required for correctness. A Select trigger focused in navigate mode would open on the same Arrow press we use to move cells. The mode boundary (navigate vs edit) must equal the focus boundary (cell vs widget), so that in navigate mode no bits-ui element is focused and in edit mode the grid does not see keys.

### Comparable apps

| App | Tab model | Clear a cell | Edit a cell |
| --- | --- | --- | --- |
| Google Sheets | single grid tab stop, arrow nav | Delete / Backspace | type, or Enter/F2 |
| Airtable | single grid tab stop, arrow nav | Delete / Backspace | Enter / Space / type |
| Excel | single grid tab stop, arrow nav | Delete | F2 / type |
| Notion DB | row/cell focus, arrow nav | Backspace clears selected cell | Enter / click |

**Key finding**: none of them put a per-cell clear button in the tab order. The eraser is unusual for a grid; it is a form idiom. Delete-on-selected-cell is the universal grid idiom. This is exactly the conclusion that motivated the spec.

### TanStack Table (`TanStack/table`)

Evaluated because it was on the reference list. TanStack Table is a headless library for the **data model** (columns, sorting, filtering, grouping, pagination, virtualization wiring). It does **not** provide focus management, roving tabindex, or keyboard cell navigation. It solves a different problem than this spec and would be a separate, larger migration of `FolderGrid`'s rendering. 

**Implication**: do not adopt TanStack Table for this work. The navigation layer is hand-rolled regardless. (If a later spec wants sorting/filtering/virtualization, that is where TanStack Table earns its place, and it would compose with, not replace, this navigation layer.)

## Target Architecture

Three pieces: a pure selection/mode controller (rune factory), a per-cell attachment that wires one `<td>` to the controller, and a small widget contract extension so each kind declares how it is entered.

```
FolderGrid.svelte  (role="grid")
  const nav = createGridNavigation({ rowCount, colCount })   // source of truth: active cell + mode
  |
  each row (role="row")
    each cell (role="gridcell")  {@attach attachGridCell(nav, { row, col, onClear })}
      |                              roving tabindex, keydown routing, focus reflection
      ModeledCell (mode="grid", interaction=<kind class>, selected, editing, onExitEdit)
        |
        per-kind widget  (marks its edit-entry element with data-cell-edit)
```

### 1. `createGridNavigation` (pure rune factory, no I/O)

Mirrors `create-cell-edit.svelte.ts`: getter-backed reactive state, never destructured. It owns ONLY selection and mode. It does not know about saving or clearing (honest asymmetry: navigation state is not vault writes).

```ts
// apps/matter/src/lib/components/grid/create-grid-navigation.svelte.ts
createGridNavigation(options: {
  rowCount: () => number;          // getters: reactive to the filtered visibleRows
  colCount: () => number;
  pageRows?: () => number;         // PageUp/Down step, default 10
}) -> {
  get active(): { row: number; col: number } | null;
  get mode(): 'navigate' | 'edit';
  isActive(row: number, col: number): boolean;
  select(row: number, col: number): void;     // set active, mode = navigate
  move(to: Move): void;                        // Move = 'up'|'down'|'left'|'right'|'rowStart'|'rowEnd'|'gridStart'|'gridEnd'|'pageUp'|'pageDown'; clamps, no wrap
  enterEdit(): void;                           // navigate -> edit (no-op if no active cell)
  exitEdit(opts?: { advance?: boolean }): void;// edit -> navigate; advance moves down one row (Enter-commit)
  clampToBounds(): void;                        // call when rowCount/colCount shrink (filter change)
}
```

Notes:
- `active` starts `null` (nothing selected until the user tabs in or clicks).
- `clampToBounds()` is invoked from a `$effect` in FolderGrid keyed on `rowCount`/`colCount` so the attention filter switching `visibleRows` cannot leave `active` pointing at a vanished row.

### 2. `attachGridCell` (Svelte attachment, the side-effect boundary)

An attachment matches the repo's `attach*` primitive philosophy (side-effectful, registers listeners at call time). One per `<td role="gridcell">`. It is the only place that touches the DOM focus.

Responsibilities:
- **Roving tabindex**: set the host `tabindex` to `0` when `nav.isActive(row,col)` and the cell is the navigate-focus target, else `-1`.
- **Descendant tabindex management**: in navigate mode, set every focusable descendant to `tabindex="-1"` so the grid is one tab stop; in edit mode, restore them (or focus the designated `[data-cell-edit]` element).
- **Focus reflection**: when the cell becomes active in navigate mode, `host.focus()`; on `focusin` from a click, call `nav.select(row,col)`.
- **Keydown routing** (navigate mode only; in edit mode the widget owns keys):
  - Arrows / Home / End / Ctrl+Home/End / PageUp/Down: `event.preventDefault()` then `nav.move(...)`.
  - `Enter` / `F2`: `nav.enterEdit()` then focus the cell's `[data-cell-edit]` element (text/select/tags) OR toggle inline (boolean) per interaction class.
  - printable character: `nav.enterEdit()` then seed the widget (Phase 2; Phase 1 may just enter edit).
  - `Delete` / `Backspace`: `options.onClear()` (the existing `onSaveField(name, key, undefined)`), guarded so it is a no-op for `NEEDS_VALUE` and for the identity column.
  - `Tab`: do nothing (let the browser move focus out of the grid; roving tabindex already makes that one stop).
- **Escape from edit**: on `keydown` Escape while focus is inside the cell, `nav.exitEdit()` and `host.focus()`. (Composites that consume Escape first, like an open Select, are handled in Open Questions.)

### 3. Widget interaction catalog (the per-kind contract extension)

Each kind declares an **interaction class** that tells `attachGridCell` how Enter behaves and where focus goes. This mirrors the existing `registry.ts` exhaustiveness gate (`satisfies Record<Kind, ...>`).

```ts
type Interaction =
  | 'text-edit'      // Enter -> focus the cell's <input>; the value display is a button today
  | 'inline-toggle'  // boolean: focus the checkbox directly in navigate mode; Space toggles, no edit mode
  | 'popover'        // select / multiSelect: Enter -> focus trigger + open; Escape closes then returns
  | 'multi-input';   // tags: Enter -> focus the always-on input; Escape returns to navigate
```

| Kind | Interaction | Navigate focus target | Enter does | Delete does |
| --- | --- | --- | --- | --- |
| string | text-edit | the gridcell | focus input (select all) | clear key |
| integer / number | text-edit | the gridcell | focus input | clear key |
| datetime | text-edit | the gridcell | focus input | clear key |
| url | text-edit (link is not the activator) | the gridcell | focus input via the pencil's `start()` | clear key |
| boolean | inline-toggle | the checkbox | n/a (Space toggles inline) | clear key (back to NEEDS_VALUE) |
| select | popover | the gridcell | focus trigger, open menu | clear key |
| multiSelect | popover | the gridcell | focus trigger, open menu | clear key |
| tags | multi-input | the gridcell | focus the chips input | clear key (whole field) |
| INVALID (any) | text-edit | the gridcell | focus the repair input | clear key |

The widget marks its edit-entry element with `data-cell-edit` so the attachment can focus it without knowing the widget internals. For `text-edit`, see the editing-ownership decision below (the input does not exist until editing starts).

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Interaction model | 1 evidence | Two-mode (navigate/edit), focus location == mode | WAI-ARIA grid pattern (verified). Required for Select correctness, not just polish. |
| Tab model | 1 evidence | Roving tabindex, one tab stop, no edge wrap | WAI-ARIA grid pattern (verified). |
| Select / multiSelect entry | 1 evidence | Edit mode only; never focused in navigate mode | bits-ui Select opens on Arrow/Enter/Space when focused (verified). |
| Boolean entry | 1 evidence | Focus the checkbox directly in navigate mode; Space toggles | bits-ui Checkbox intercepts only Space, not arrows (verified); APG "non-arrow widget" rule. |
| Controller shape | 2 coherence | `createGridNavigation` rune factory, getter-backed, no destructure, no I/O | Mirrors `createCellEdit`; honest asymmetry (selection state is not a vault write). |
| Cell wiring | 2 coherence | `attachGridCell` attachment, the only DOM-focus owner | Matches `attach*` side-effect primitive convention; keeps `ModeledCell` render-only. |
| Per-kind dispatch | 2 coherence | `Interaction` map with `satisfies Record<Kind, Interaction>` | Same exhaustiveness gate as `registry.ts` / `COLUMN_WIDTH`. |
| Clear keystroke | 2 coherence | Delete / Backspace in navigate mode calls existing `clear` prop | The original motivation; data contract unchanged (deletes key, never `null`). |
| Eraser button fate | 3 taste | Keep as mouse sugar, `tabindex=-1`; stay persistent on INVALID | Mouse users keep one-click clear; keyboard users use Delete; grid stays one tab stop. Revisit if usability testing says the button is now redundant. |
| Editing ownership | 3 taste / OPEN | See Open Question 1 (controlled vs delegated) | The single biggest fork; prototype before committing. |
| TanStack Table | 1 evidence | Not adopted for this work | Headless data model, not focus/keyboard; different problem (verified). |
| Detail dialog | 3 taste | Stays a form (native tab order), NOT a grid | It is a vertical form, one control per row; grid nav there is overkill. Revisit if users ask for arrow nav in the dialog. |

## The editing-ownership fork (the hard part)

`text-edit` widgets render a `<button>` display and swap to an `<input>` only when their own `createCellEdit().editing` is true, started by `onclick`. For Enter-to-edit, the grid must cause that swap. Two ways:

### Option A: Controlled editing (grid is the authority)

Lift `editing` out of `createCellEdit` into the controller. `ModeledCell` receives `selected` and `editing` props and an `onExitEdit` callback; `createCellEdit` takes `editing: () => boolean` instead of owning it; each widget interprets `editing` (text shows input, select opens, tags focuses input).

- Pros: single source of truth; clean Escape/commit (`onExitEdit` fires back to the controller); no focus-timing magic; the mode boundary is explicit.
- Cons: touches `createCellEdit` and every `text-edit` widget + `TextCell` + `UrlField` + `JsonRepairEditor`; bigger diff.

### Option B: Delegated editing (grid triggers, widget still owns)

`attachGridCell` enters edit by focusing/clicking the widget's `[data-cell-edit]` element, reusing the existing `onclick=edit.start`. `TextCell`'s input already self-focuses (`{@attach (node) => node.select()}`), so a synth-click yields a focused input for free. Mode is inferred from focus location (focus inside cell == edit). Exit is detected on `focusout` returning to the cell.

- Pros: minimal widget churn; reuses existing click-to-edit; fastest Phase 1.
- Cons: focus-timing fragility (commit-on-blur vs refocus races); composites (Select open/close, tags Escape) need bespoke handling; "mode" is implicit in focus, which is harder to reason about.

**Recommendation**: Prototype Option B for `text-edit` first to ship Phase 1 fast, but expect to converge on Option A for robustness once composites are wired. Leave this open; the prototype decides. Whichever wins, the controller (`createGridNavigation`) and the attachment (`attachGridCell`) are identical; only the widget contract differs.

## Call sites: before and after

### FolderGrid modeled cell loop

**Before** (`apps/matter/src/lib/components/FolderGrid.svelte:335`):

```svelte
{#each conf.cells as cell (cell.field.name)}
  <Table.Cell
    aria-invalid={cell.state === 'INVALID' || cell.state === 'NEEDS_VALUE'}
    class={[alignClass(cell.field.kind), cellStateClass(cell.state)]}
  >
    <ModeledCell {cell} mode="grid"
      save={(value) => onSaveField(conf.row.name, cell.field.name, value)}
      clear={() => onSaveField(conf.row.name, cell.field.name, undefined)} />
  </Table.Cell>
{/each}
```

**After** (sketch; `rowIndex`/`colIndex` from the `{#each}` index, identity column is col 0):

```svelte
{#each conf.cells as cell, colIndex (cell.field.name)}
  <Table.Cell
    role="gridcell"
    aria-invalid={cell.state === 'INVALID' || cell.state === 'NEEDS_VALUE'}
    class={[alignClass(cell.field.kind), cellStateClass(cell.state),
            nav.isActive(rowIndex, colIndex + 1) && 'ring-2 ring-inset ring-ring']}
    {@attach attachGridCell(nav, {
      row: rowIndex, col: colIndex + 1,
      clearable: cell.state !== 'NEEDS_VALUE',
      onClear: () => onSaveField(conf.row.name, cell.field.name, undefined),
    })}
  >
    <ModeledCell {cell} mode="grid"
      interaction={INTERACTION[cell.field.kind]}
      save={(value) => onSaveField(conf.row.name, cell.field.name, value)}
      clear={() => onSaveField(conf.row.name, cell.field.name, undefined)} />
  </Table.Cell>
{/each}
```

Plus `role="grid"` on `Table.Root`, `role="row"` on each `Table.Row`, `role="columnheader"` on heads, and `aria-rowcount`/`aria-colcount`.

**Semantic shift to flag**: cells become focusable `<td>`s; their inner controls go `tabindex=-1` in navigate mode. Any test or behavior assuming "Tab reaches the Select trigger directly" changes to "Tab reaches the grid; arrow + Enter reaches the Select".

### createCellEdit (only if Option A wins)

**Before** (`apps/matter/src/lib/components/fields/create-cell-edit.svelte.ts:55`): owns `let editing = $state(false)`, started by `start()`.

**After**: `editing` is passed in (`editing: () => boolean`), `start`/`cancel` call an injected `onExitEdit`/`onEnterEdit`, and the widget's input visibility is driven by the controller. (Do not do this in Phase 1 if Option B holds for text widgets.)

## Implementation Plan

### Phase 0: Prototype the editing fork (decision spike)

- [ ] **0.1** Build `createGridNavigation` (navigate-only, arrows + Home/End + Delete, no edit mode).
- [ ] **0.2** Build `attachGridCell` for navigate mode + roving tabindex + Delete-to-clear, wire ONE column (string) end to end.
- [ ] **0.3** Try Option B (synth focus/click) vs Option A (controlled) for entering edit on a `string` cell. Pick one. Record the choice in this spec's Decisions Log.

### Phase 1: Core skeleton (text kinds + boolean)

- [ ] **1.1** `createGridNavigation` complete: move (no wrap), Home/End, Ctrl+Home/End, PageUp/Down, enterEdit/exitEdit, clampToBounds.
- [ ] **1.2** `attachGridCell`: roving tabindex, descendant tabindex management, focus reflection, full keydown routing.
- [ ] **1.3** ARIA roles on the modeled table: `grid`, `row`, `columnheader`, `gridcell`, `aria-rowcount`/`aria-colcount`, identity column as col 0.
- [ ] **1.4** `INTERACTION` map (`satisfies Record<Kind, Interaction>`) and thread `interaction` into `ModeledCell`.
- [ ] **1.5** Wire `text-edit` widgets (string, integer, number, datetime, url, JSON repair) via the chosen fork.
- [ ] **1.6** Wire `inline-toggle` (boolean): focus checkbox directly, Space toggles, Delete clears.
- [ ] **1.7** Selection ring on the active cell (reuse the existing inset-ring vocabulary so it does not fight the amber/destructive state rings).
- [ ] **1.8** Demote the eraser `Button` to `tabindex=-1` mouse sugar; keep it persistent on INVALID.
- [ ] **1.9** Clamp `active` on `visibleRows` change (attention filter) and when a row count drops.
- [ ] **1.10** Interim handling for select / multiSelect / tags: Enter focuses the widget and lets it behave as today; Escape returns to the cell. Mark as not-yet-hardened.

### Phase 2: Composite widgets + full keymap

- [ ] **2.1** Select / multiSelect: enter edit -> focus trigger + open; on value commit or close, return focus to the cell (navigate). Resolve the Escape double-handling (Open Question 4).
- [ ] **2.2** tags: edit mode focuses the input; Escape returns to navigate; chip X removal and Backspace-pop stay inside edit mode only.
- [ ] **2.3** Type-to-edit: a printable key enters edit mode and seeds the first character (Excel behavior).
- [ ] **2.4** Enter-commit advance (move down a row after commit) per Open Question 2.
- [ ] **2.5** Shift+Tab and Tab semantics audit in both modes.

### Phase 3: Parity and polish

- [ ] **3.1** Decide and implement detail-dialog behavior (recommend: keep native form tab order; no grid nav).
- [ ] **3.2** Unmodeled raw table: read-only, exclude from grid nav or make it a single tab stop.
- [ ] **3.3** Tests: unit tests for `createGridNavigation` movement/clamping; component tests for keymap and clear-on-Delete; a11y smoke (roles, single tab stop).
- [ ] **3.4** Docs: a short note in the Matter components folder on the grid interaction model.

## Edge Cases

### Attention filter changes the row set mid-navigation
1. User selects cell (row 12, col 3) with the "all rows" filter.
2. They switch to "needs attention", which shrinks `visibleRows` to 5.
3. `active.row = 12` is now out of bounds. `clampToBounds()` resets it to the last valid row (or clears selection). Expected: no crash, selection lands somewhere valid.

### NEEDS_VALUE cell
1. Selected cell has no value. Delete is a no-op (nothing to clear). Enter enters edit to fill it. Boolean indeterminate: Space sets `true` (fills), Delete returns to NEEDS_VALUE.

### INVALID cell
1. Edit mode is the JsonRepairEditor. Delete clears the key (a valid repair path). The persistent eraser also remains for mouse.

### Row detail dialog open over the grid
1. Dialog traps focus; grid keydown should not fire underneath. Verify the dialog's focus trap covers this; if not, gate grid keydown on `!detailOpen`.

### Identity (file name) column
1. It is col 0: focusable, navigable, Enter opens the row detail (it already has the open `Button`). Delete is a no-op (you cannot clear a file name).

### Single row or single column grid
1. Arrow moves in the absent axis are no-ops (clamped). No wrap.

### bits-ui Select open consumes Escape
1. In edit mode with the Select open, the first Escape closes the menu (bits-ui), it should NOT also exit to navigate in the same keypress. See Open Question 4.

## Open Questions

1. **Editing ownership: controlled (Option A) or delegated (Option B)?**
   - Options: (a) lift `editing` to the controller, widgets become controlled; (b) keep `createCellEdit` self-owned, grid triggers via focus/synthetic click and infers mode from focus.
   - **Recommendation**: prototype B for text in Phase 0/1, expect to converge on A when composites land. Leave open until the spike.

2. **Enter-commit: stay on the cell (F2 semantics) or advance down a row (Excel)?**
   - **Recommendation**: advance down for spreadsheet muscle memory; make it the `exitEdit({ advance: true })` path. Open.

3. **`attachGridCell` as an attachment vs a `GridCell.svelte` wrapper component?**
   - Options: (a) attachment on the existing `<Table.Cell>` (matches `attach*` convention, keeps markup flat); (b) a wrapper component (easier `$effect` lifecycle, but another nesting layer).
   - **Recommendation**: attachment. Revisit if the effect lifecycle (focus-on-active) gets awkward inside an attachment.

4. **Escape double-handling for open Select.**
   - Options: (a) track each Select cell's `open` state and only `exitEdit` when closed; (b) let bits-ui consume Escape and detect via a `focusout` that focus left the popover; (c) bind `open` through the controller so the grid knows.
   - **Recommendation**: bind `open` (c) so the mode machine sees menu state directly. Open.

5. **Type-to-edit seeding** (printable key both enters edit and inserts the character).
   - **Recommendation**: Phase 2; Phase 1 can enter edit without seeding.

6. **Keep the per-cell eraser at all once Delete works?**
   - **Recommendation**: keep as mouse sugar (`tabindex=-1`), persistent on INVALID. Revisit after usability testing; it may become pure noise.

7. **Does the identity column participate in nav, or is it a separate region?**
   - **Recommendation**: participate as col 0 (Enter opens detail). Open if it complicates the keymap.

## Adjacent Work

- Sorting / filtering / virtualization via TanStack Table: not required now. Would compose above this navigation layer in a later spec if the grid needs to scale past a few hundred rows.
- Multi-cell selection (Shift+Arrow ranges, copy/paste a block): explicitly out of scope. Single active cell only.
- Detail dialog arrow navigation: deferred; the dialog stays a form.

## Decisions Log

- Keep the per-cell eraser button (now mouse-only, `tabindex=-1`): constraint is mouse users want a one-click clear without learning Delete, and INVALID cells want a visible repair path.
  Revisit when: usability testing shows the button is redundant once Delete is discoverable, or it visually competes with the new selection ring.
- Detail dialog stays a form, not a grid: constraint is it is a one-control-per-row vertical form where arrow-cell-nav has no meaning.
  Revisit when: the dialog grows a tabular sub-view, or users request spreadsheet keys inside it.

## Success Criteria

- [ ] The modeled grid is a single tab stop: Tab in lands on one cell, Tab again leaves the grid.
- [ ] Arrow keys move the selected cell with no edge wrap; Home/End, Ctrl+Home/End, PageUp/Down work.
- [ ] Enter / F2 enters edit mode and focus moves into the widget; Escape returns to the cell.
- [ ] Delete / Backspace clears the selected cell via `onSaveField(name, key, undefined)` (key removed, never `null`); no-op on NEEDS_VALUE and the identity column.
- [ ] Select / multiSelect never open on a navigation Arrow press (they only open in edit mode).
- [ ] Boolean toggles with Space; clears with Delete.
- [ ] The eraser button is not in the tab order; mouse click still clears; INVALID still shows it persistently.
- [ ] Screen reader announces grid/row/gridcell roles and a coherent position (`aria-rowindex`/`aria-colindex`), not a flat list of buttons.
- [ ] `bun run typecheck` and `bun test` pass in `apps/matter`; existing data-semantics tests unchanged.

## References

- `apps/matter/src/lib/components/FolderGrid.svelte` - the modeled table; integration point for `role="grid"` + `attachGridCell`.
- `apps/matter/src/lib/components/ModeledCell.svelte` - per-cell dispatch + eraser; gains `interaction` (and possibly `selected`/`editing`).
- `apps/matter/src/lib/components/fields/create-cell-edit.svelte.ts` - the editing lifecycle; the controlled-vs-delegated fork lives here.
- `apps/matter/src/lib/components/fields/registry.ts` - the `satisfies Record<Kind, ...>` pattern the `INTERACTION` map should mirror.
- `apps/matter/src/lib/components/fields/TextCell.svelte` - text-edit display/input swap and the self-focus `{@attach node.select()}`.
- `apps/matter/src/lib/components/fields/SelectField.svelte`, `BooleanField.svelte`, `TagsField.svelte` - the composite widgets that need per-kind interaction handling.
- `apps/matter/src/lib/core/conformance.ts` - `Cell` state union (`OK` / `NEEDS_VALUE` / `INVALID`) the keymap branches on.
- WAI-ARIA APG grid pattern and `huntabyte/bits-ui` Select/Checkbox keyboard behavior (both verified above) - the external contracts.
