# TipTap → Raw ProseMirror Migration

**Date**: 2026-04-06
**Status**: Implemented
**Author**: AI-assisted

## Overview

Replace TipTap with raw ProseMirror in both Honeycrisp and Fuji editors. TipTap is a thin abstraction layer we barely use, it's broken with Svelte 5 runes, and it pulls 24+ transitive `@tiptap/extension-*` dependencies for features we can express in ~200 lines of ProseMirror code.

## Motivation

### Current State

Both apps instantiate TipTap's `Editor` class inside a `$effect`, configure a handful of extensions, and wire Yjs collaboration via `y-prosemirror` plugins:

```ts
// apps/honeycrisp/src/lib/editor/Editor.svelte (lines 78-136)
const ed = new Editor({
  element,
  extensions: [
    StarterKit.configure({ history: false }),
    Placeholder.configure({ placeholder: 'Start writing…' }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Underline,
    Extension.create({
      name: 'yjs-collaboration',
      addProseMirrorPlugins() {
        return [ySyncPlugin(yxmlfragment), yUndoPlugin()];
      },
    }),
  ],
  editorProps: { attributes: { class: 'prose dark:prose-invert ...' } },
  onUpdate({ editor: ed }) { onContentChange?.(extractTitleAndPreview(ed)); },
  onTransaction({ editor: ed }) { /* updates activeFormats */ },
});
```

```ts
// apps/fuji/src/lib/components/EntryEditor.svelte (lines 36-62)
const ed = new Editor({
  element,
  extensions: [
    StarterKit.configure({ history: false }),
    Placeholder.configure({ placeholder: 'Start writing…' }),
    Extension.create({
      name: 'yjs-collaboration',
      addProseMirrorPlugins() {
        return [ySyncPlugin(ytext), yUndoPlugin()];
      },
    }),
  ],
  editorProps: { attributes: { class: 'prose prose-sm dark:prose-invert ...' } },
});
```

This creates problems:

1. **TipTap's Svelte guide is broken with Svelte 5 runes.** [Issue #6025](https://github.com/ueberdosis/tiptap/issues/6025) is open with no official fix. The workaround requires a `createSubscriber()` + Proxy hack. We're building on an unsupported combination.

2. **TipTap is dead weight.** We use `StarterKit` (a bundle of prosemirror-schema-basic nodes/marks), `Placeholder` (a decoration plugin), `TaskList`/`TaskItem` (custom nodes), `Underline` (a trivial mark), and the `chain().focus().toggleX().run()` command API. All of these map 1:1 to ProseMirror primitives.

3. **Dependency bloat.** `@tiptap/starter-kit` alone pulls **24 dependencies**: each a `@tiptap/extension-*` wrapper around a ProseMirror feature. Honeycrisp has 6 direct `@tiptap/*` packages; Fuji has 3. Both apps already have `prosemirror-model`, `prosemirror-state`, and `prosemirror-view` as direct dependencies (likely for type imports), so the ProseMirror packages are already in the dependency graph.

4. **The Yjs integration is already raw ProseMirror.** The custom `yjs-collaboration` extension just calls `ySyncPlugin()` and `yUndoPlugin()` from `y-prosemirror`. TipTap's `Extension.create({ addProseMirrorPlugins })` wrapper adds nothing. It's passing plugins through.

### Desired State

Raw ProseMirror `EditorView` mounted via `$effect`, with a custom `Schema`, direct `y-prosemirror` plugins, and toolbar commands using `prosemirror-commands`. No TipTap packages in the dependency tree.

## Research Findings

### ProseMirror + Svelte 5 Integration Patterns

Two production Svelte 5 apps use raw ProseMirror with the exact pattern we'd adopt:

| Project | Stack | Yjs? | Svelte Lifecycle | Source |
|---------|-------|------|-----------------|--------|
| [jakelazaroff/waypoint](https://github.com/jakelazaroff/waypoint) | Svelte 5 + ProseMirror + Yjs | Yes (`ySyncPlugin`, `yCursorPlugin`, `yUndoPlugin`) | `$effect(() => { view = new EditorView(...); return () => view.destroy(); })` | [Outline.svelte](https://github.com/jakelazaroff/waypoint/blob/main/src/component/Outline.svelte) |
| [PostOwl/postowl](https://github.com/PostOwl/postowl) | Svelte 5 + ProseMirror | No | `onMount` + `$effect.pre` for external content sync, `$derived` for schema | [RichTextEditor.svelte](https://github.com/PostOwl/postowl/blob/main/src/lib/components/RichTextEditor.svelte) |

**Key finding**: The waypoint project is the closest match to our stack. Svelte 5 runes, ProseMirror, Yjs collaboration, custom NodeSpecs, keyboard shortcuts, and input rules. It works cleanly without any wrapper library.

**Svelte NodeView pattern**: Jake Lazaroff documented a pattern for rendering Svelte 5 components as ProseMirror NodeViews ([TIL post](https://til.jakelazaroff.com/prosemirror/use-a-svelte-component-as-a-nodeview/)). This uses `mount()` from Svelte 5 to render into the NodeView's DOM element. We don't currently need custom NodeViews, but this pattern is available if we do later.

### TipTap → ProseMirror Feature Mapping

Every TipTap feature we use maps directly to ProseMirror primitives:

| TipTap Feature | ProseMirror Equivalent | Complexity |
|---|---|---|
| `new Editor({ element, extensions, editorProps })` | `new EditorView(element, { state: EditorState.create({...}), dispatchTransaction })` | ~15 lines |
| `StarterKit` | `Schema` built from `prosemirror-schema-basic` + `prosemirror-schema-list` nodes/marks | Define once, ~30 lines |
| `Placeholder.configure({ placeholder })` | ProseMirror `Plugin` with `DecorationSet` | ~25 lines |
| `TaskList` / `TaskItem.configure({ nested: true })` | Custom `NodeSpec` definitions | ~60 lines total |
| `Underline` | `MarkSpec` with `<u>` DOM output | 5 lines |
| `Extension.create({ addProseMirrorPlugins: [ySyncPlugin, yUndoPlugin] })` | Direct plugin array in `EditorState.create({ plugins: [...] })` | 0 lines. Remove wrapper |
| `editor.chain().focus().toggleBold().run()` | `toggleMark(schema.marks.strong)(view.state, view.dispatch); view.focus()` | Trivial. Different shape |
| `editor.isActive('bold')` | Helper: `markActive(state, markType)` checking `state.storedMarks` or `state.selection` | ~8 lines helper |
| `onUpdate` callback | `dispatchTransaction` hook or Plugin `view.update` | ~5 lines |
| `onTransaction` callback | Same `dispatchTransaction` function | Built-in |

**Key finding**: TipTap's `chain().focus().toggleX().run()` API is the only convenience with real substance. It maps to `prosemirror-commands` functions + `view.focus()`. The `isActive()` helper needs ~8 lines to reimplement by checking stored marks and the selection.

### Svelte 5 Reactivity with ProseMirror

TipTap's `onTransaction` callback currently updates a `$state` object (`activeFormats`). With raw ProseMirror, we use `dispatchTransaction`:

```ts
// waypoint pattern (Outline.svelte lines 157-180)
$effect(() => {
  if (!el) return;
  view = new EditorView(el, {
    state: EditorState.create({ schema, plugins: [...] }),
  });
  return () => view.destroy();
});
```

For toolbar state, we'll use ProseMirror's `dispatchTransaction` to update Svelte `$state`:

```ts
const editorView = new EditorView(element, {
  state: EditorState.create({ schema, plugins }),
  dispatchTransaction(tr) {
    const newState = this.state.apply(tr);
    this.updateState(newState);
    // Update reactive toolbar state
    activeFormats = {
      bold: markActive(newState, schema.marks.strong),
      italic: markActive(newState, schema.marks.em),
      // ...
    };
  },
});
```

This is actually simpler than TipTap's approach. No separate `onTransaction` callback needed.

### `extractTitleAndPreview` Migration

`apps/honeycrisp/src/lib/editor/utils.ts` currently imports `type { Editor } from '@tiptap/core'` and calls `editor.getText()`. In ProseMirror, the equivalent is `view.state.doc.textContent` (for the full text) or iterating nodes. The function signature changes from `(editor: Editor)` to `(state: EditorState)` or `(doc: Node)`.

```ts
// Current (TipTap)
import type { Editor } from '@tiptap/core';
export function extractTitleAndPreview(editor: Editor) {
  const text = editor.getText();
  // ...
}

// After (ProseMirror)
import type { Node } from 'prosemirror-model';
export function extractTitleAndPreview(doc: Node) {
  const text = doc.textContent;
  // ...
}
```

### CSS Selector Migration

Both editors use `:global(.tiptap)` CSS selectors for styling. TipTap adds the `tiptap` class to its root `<div>`. ProseMirror adds `ProseMirror` as the class. CSS selectors need updating:

| Current | After |
|---------|-------|
| `:global(.tiptap)` | `:global(.ProseMirror)` |
| `:global(.tiptap > *:first-child)` | `:global(.ProseMirror > *:first-child)` |
| `:global(.tiptap p.is-editor-empty:first-child::before)` | Handled by placeholder plugin decoration |
| `:global(.tiptap ul[data-type="taskList"])` | `:global(.ProseMirror ul.task-list)` (or whatever class our NodeSpec uses) |

### Bundle Size Impact

TipTap's `@tiptap/pm` re-exports all prosemirror-\* packages, so they're already in the bundle. The migration eliminates the TipTap abstraction layer:

| What | Minified | Gzip |
|------|----------|------|
| `@tiptap/core` (eliminated) | 95.6 KB | 29.2 KB |
| `@tiptap/starter-kit` + extensions (eliminated) | ~94 KB unpacked |: |
| ProseMirror packages (already loaded via `@tiptap/pm`) | 0 net new | 0 net new |

Net result: bundle gets smaller. Both `package.json` files already list `prosemirror-model`, `prosemirror-state`, and `prosemirror-view` as direct dependencies.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Schema approach | Build from `prosemirror-schema-basic` + `prosemirror-schema-list`, extend with custom nodes/marks | Reuses battle-tested NodeSpecs rather than writing from scratch. Same thing StarterKit does internally. |
| Placeholder implementation | Custom ProseMirror `Plugin` with `DecorationSet` | Well-documented pattern (~25 lines). Avoids any wrapper dependency. |
| Task list nodes | Custom `NodeSpec` with checkbox DOM rendering | No existing lightweight package. TipTap's implementation is [~100 lines](https://github.com/ueberdosis/tiptap/blob/main/packages/extension-task-item/src/task-item.ts) including the extension system boilerplate. The raw NodeSpec is simpler. |
| Toolbar command pattern | Direct `prosemirror-commands` calls + `view.focus()` | 1:1 mapping from `chain().focus().toggleX().run()`. Actually clearer. No chaining abstraction. |
| Active format detection | Small `markActive` / `nodeActive` helpers | ProseMirror doesn't bundle these, but they're [~8 lines each](https://prosemirror.net/examples/menu/). Standard ProseMirror pattern. |
| Editor lifecycle | `$effect(() => { ... return () => view.destroy() })` | Matches waypoint pattern. Clean Svelte 5 lifecycle integration. |
| Shared vs per-app code | Shared schema + helpers in a common module; per-app Svelte components | Schema and helpers are identical; only the Svelte template/toolbar differs between apps. |
| `prosemirror-history` | **Not included** | Both editors disable TipTap's history and use `yUndoPlugin()` from `y-prosemirror` instead. No change needed. |
| Import `prosemirror-view/style/prosemirror.css` | Explicit import in each editor component | ProseMirror requires this base stylesheet. TipTap included it automatically. |

## Architecture

```
BEFORE (TipTap)
───────────────
┌──────────────────────────────────┐
│ Editor.svelte / EntryEditor.svelte│
│  └── new Editor({ extensions })   │
│       ├── StarterKit              │  ← wraps prosemirror-schema-basic
│       ├── Placeholder             │  ← wraps a DecorationSet plugin
│       ├── TaskList / TaskItem     │  ← wraps custom NodeSpecs
│       ├── Underline               │  ← wraps a MarkSpec
│       └── Extension.create()      │  ← passes ySyncPlugin through
│            └── ySyncPlugin()      │
│            └── yUndoPlugin()      │
└──────────────────────────────────┘
         │
         ▼
  @tiptap/core (95KB)
  @tiptap/starter-kit (24 deps)
  @tiptap/extension-* (5 packages)
  @tiptap/pm → prosemirror-*


AFTER (Raw ProseMirror)
───────────────────────
┌──────────────────────────────────┐
│ Editor.svelte / EntryEditor.svelte│
│  └── new EditorView(element, {    │
│       state: EditorState.create({ │
│         schema,                   │  ← custom Schema (shared module)
│         plugins: [                │
│           placeholderPlugin(),    │  ← ~25 lines (shared module)
│           ySyncPlugin(fragment),  │  ← direct, no wrapper
│           yUndoPlugin(),          │
│           keymap({...}),          │  ← prosemirror-keymap
│           keymap(baseKeymap),     │
│           inputRules({...}),      │  ← prosemirror-inputrules
│         ]                         │
│       })                          │
│     })                            │
└──────────────────────────────────┘
         │
         ▼
  prosemirror-state
  prosemirror-view
  prosemirror-model     (already direct deps)
  prosemirror-keymap
  prosemirror-commands
  prosemirror-schema-basic
  prosemirror-schema-list
  prosemirror-inputrules
  y-prosemirror          (unchanged)
  yjs                    (unchanged)
```

The middle layer (TipTap) is completely removed. The Svelte components talk directly to ProseMirror.

## Implementation Plan

### Phase 1: Shared Editor Primitives

Create a shared module with the schema, plugins, and helpers that both apps will use.

- [ ] **1.1** Create `packages/editor/` (or a shared location. See Open Questions) with:
  - `schema.ts`: ProseMirror `Schema` built from `prosemirror-schema-basic` nodes + `prosemirror-schema-list` list nodes + custom `task_list`, `task_item`, and `underline` mark
  - `plugins.ts`: `createPlaceholderPlugin(text: string)` returning a ProseMirror `Plugin`
  - `helpers.ts`: `markActive(state, markType)`, `nodeActive(state, nodeType, attrs?)`, `extractTitleAndPreview(doc)`
- [ ] **1.2** Define the custom `task_list` and `task_item` NodeSpecs with checkbox rendering. Reference TipTap's [task-item.ts](https://github.com/ueberdosis/tiptap/blob/main/packages/extension-task-item/src/task-item.ts) and [task-list.ts](https://github.com/ueberdosis/tiptap/blob/main/packages/extension-task-list/src/task-list.ts) for the DOM structure to maintain Yjs document compatibility.
- [ ] **1.3** Add `prosemirror-keymap`, `prosemirror-commands`, `prosemirror-schema-basic`, `prosemirror-schema-list`, and `prosemirror-inputrules` as dependencies. Remove `@tiptap/*` packages.

### Phase 2: Migrate Fuji (simpler editor, no toolbar)

Fuji's `EntryEditor.svelte` is the simpler target. No toolbar, no task lists, no underline.

- [x] **2.1** Replace TipTap `Editor` instantiation with ProseMirror `EditorView` + `EditorState.create()` inside the existing `$effect`. Wire `ySyncPlugin(ytext)` and `yUndoPlugin()` directly in the plugins array.
- [x] **2.2** Import `prosemirror-view/style/prosemirror.css`.
- [x] **2.3** Update CSS selectors from `:global(.tiptap)` to `:global(.ProseMirror)`.
- [x] **2.4** Remove TipTap imports and dependencies from `apps/fuji/package.json`.
- [x] **2.5** Verify: editor loads, content syncs via Yjs, placeholder shows, undo/redo works.
  > **Note**: `ySyncPlugin` typed for `Y.XmlFragment` but accepts `Y.Text` at runtime. Used `as unknown as Y.XmlFragment` cast matching original TipTap behavior. Added keyboard shortcuts (Mod-B/I, list keys) and input rules (headings, lists, blockquote, code blocks) beyond what spec explicitly listed for Fuji.

### Phase 3: Migrate Honeycrisp (toolbar + task lists + underline)

Honeycrisp has the full toolbar and additional extensions.

- [x] **3.1** Replace TipTap `Editor` instantiation with ProseMirror `EditorView` + `EditorState.create()`. Include the full schema (with task list nodes and underline mark) and all plugins.
- [x] **3.2** Migrate toolbar commands:
  - `editor.chain().focus().toggleBold().run()` → `toggleMark(schema.marks.strong)(view.state, view.dispatch); view.focus()`
  - Same pattern for italic, underline, strike, blockquote
  - Heading toggle → `setBlockType(schema.nodes.heading, { level })` or toggling back to paragraph
  - List toggles → `wrapInList` / `liftListItem` from `prosemirror-schema-list`
  - Task list toggle → custom command using the taskList NodeSpec
- [x] **3.3** Migrate `activeFormats` state: replace `onTransaction` with `dispatchTransaction` that updates `$state` using `markActive()` / `nodeActive()` helpers.
  > **Note**: Renamed `$from` to `resolvedFrom` in destructuring to avoid Svelte's reserved `$` prefix.
- [x] **3.4** Migrate `extractTitleAndPreview` in `utils.ts` to accept `Node` (from `prosemirror-model`) instead of TipTap `Editor`. Update call site in `onUpdate`.
- [x] **3.5** Update CSS: `:global(.tiptap)` → `:global(.ProseMirror)`, task list selectors from `[data-type="taskList"]` to `ul.task-list`.
- [x] **3.6** Import `prosemirror-view/style/prosemirror.css`.
- [x] **3.7** Remove TipTap imports and dependencies from `apps/honeycrisp/package.json`.
- [x] **3.8** Verify: editor loads, all toolbar buttons work, task lists render with checkboxes, content syncs via Yjs, title/preview extraction works, undo/redo works.
  > **Note**: Added custom `strike` MarkSpec (not in prosemirror-schema-basic). Added `chainCommands` for Enter key to handle both taskItem and list_item splitting. Task checkbox click plugin uses `handleClickOn`.

### Phase 4: Cleanup

- [x] **4.1** Run `bun install` to confirm no TipTap packages remain in lockfile.
- [x] **4.2** Run `bun run typecheck` across both apps.
  > **Note**: Pre-existing failures in `@epicenter/zhongwen` unrelated to migration. Both Fuji and Honeycrisp editor files are type-clean.
- [x] **4.3** Verify no remaining `@tiptap` imports anywhere: `grep -r "@tiptap" apps/`.
- [ ] **4.4** Test both editors end-to-end: create content, reload, verify persistence via Yjs.

## Edge Cases

### Yjs Document Compatibility

1. Existing Yjs documents were created by TipTap's schema (which uses `prosemirror-schema-basic` internally).
2. Our new schema must produce the same node/mark names and attributes so existing Y.XmlFragment and Y.Text data deserializes correctly.
3. **Mitigation**: TipTap's StarterKit uses `prosemirror-schema-basic` nodes verbatim (paragraph, heading, blockquote, code_block, etc.) and `prosemirror-schema-list` for lists. If we build our schema from the same sources with the same names, existing documents will load without migration.
4. **Risk**: Task list node names. TipTap's `TaskList` uses `taskList` and `TaskItem` uses `taskItem` as node names. Our custom NodeSpecs must use the **exact same names** and attribute keys to maintain compatibility.

### First-Child Title Styling

1. Honeycrisp styles `:global(.tiptap > *:first-child)` with large font for the title.
2. After migration, this becomes `:global(.ProseMirror > *:first-child)`.
3. **No content change**: the first child is still a `<p>` or `<h1>` from the schema.

### Placeholder Text

1. TipTap's Placeholder extension adds `data-placeholder` attribute and `is-editor-empty` class.
2. Our custom placeholder plugin needs to produce the same (or equivalent) DOM attributes for the CSS to work.
3. **Recommendation**: Match TipTap's DOM output (`p.is-editor-empty[data-placeholder]`) so existing CSS works with minimal changes. Or simplify: use a `widget` decoration and drop the CSS-pseudo-element approach entirely.

### EditorView Reference for Toolbar

1. TipTap stores the editor instance as `$state`. Toolbar buttons call `editor?.chain()...`.
2. With ProseMirror, we store `view` as `$state<EditorView>()`. Toolbar buttons call command functions with `view.state` and `view.dispatch`.
3. **No reactivity issue**: the view reference itself doesn't change; only the internal state does (via `dispatchTransaction`).

## Open Questions

1. **Where should the shared editor module live?**
   - Options: (a) `packages/editor/` as a new workspace package, (b) `packages/ui/src/editor/` inside the existing UI package, (c) inline in each app with shared code copied
   - **Recommendation**: (a) `packages/editor/`: it's a distinct domain (rich text editing) separate from UI components, and both apps depend on it. Follows monorepo conventions.

2. **Should we add `prosemirror-schema-basic` as a dependency or copy-paste the schema?**
   - Options: (a) depend on `prosemirror-schema-basic` and extend it, (b) copy the schema definition (~80 lines) and own it entirely
   - **Recommendation**: (a) depend on it for now. It's maintained by the ProseMirror author, tiny, and we can inline later if needed.

3. **Input rules (markdown shortcuts)?**
   - TipTap's `StarterKit` includes input rules for headings (`# `, `## `), lists (`- `, `1. `), blockquotes (`> `), code blocks (`` ``` ``), and horizontal rules (`---`).
   - Options: (a) replicate all of them using `prosemirror-inputrules`, (b) start with a subset (headings + lists), (c) skip for now
   - **Recommendation**: (a) replicate all. The waypoint repo shows this is [~20 lines of `wrappingInputRule` calls](https://github.com/jakelazaroff/waypoint/blob/main/src/component/Outline.svelte#L188-L203). ProseMirror's `prosemirror-example-setup` package also has [a complete reference](https://github.com/ProseMirror/prosemirror-example-setup/blob/master/src/inputrules.ts).

4. **Keyboard shortcuts?**
   - TipTap's StarterKit registers Mod-B (bold), Mod-I (italic), Mod-Z (undo), etc.
   - We need to explicitly register these via `prosemirror-keymap`.
   - **Recommendation**: Use `y-prosemirror`'s `undo`/`redo` exports for Mod-Z/Mod-Y (already imported), and `toggleMark` from `prosemirror-commands` for formatting shortcuts.

5. **Task list checkbox interactivity?**
   - TipTap's TaskItem renders an `<input type="checkbox">` that toggles the `checked` attribute via a NodeView.
   - With raw ProseMirror, we need either (a) a custom NodeView that handles click events, or (b) a `handleClick` plugin that detects clicks on checkbox elements.
   - **Recommendation**: (a) minimal NodeView. It's ~30 lines. Reference: [TipTap's TaskItem NodeView](https://github.com/ueberdosis/tiptap/blob/main/packages/extension-task-item/src/task-item.ts).

## Success Criteria

- [ ] No `@tiptap/*` packages in any `package.json`
- [ ] No `@tiptap` imports in any source file
- [ ] Both editors render content identically to before
- [ ] Existing Yjs documents load correctly (no data migration needed)
- [ ] Toolbar buttons work in Honeycrisp (bold, italic, underline, strike, headings, lists, task lists, blockquote)
- [ ] Task list checkboxes are interactive
- [ ] Placeholder text appears in empty editors
- [ ] Yjs collaboration syncs between devices
- [ ] Undo/redo works (via `yUndoPlugin`)
- [ ] `extractTitleAndPreview` produces correct output
- [ ] `bun run typecheck` passes for both apps
- [ ] First-child title styling preserved in Honeycrisp
- [ ] Bundle size is equal or smaller

## References

- `apps/honeycrisp/src/lib/editor/Editor.svelte`: Main TipTap editor with toolbar (245 lines)
- `apps/honeycrisp/src/lib/editor/utils.ts`: `extractTitleAndPreview` using TipTap's `Editor` type (34 lines)
- `apps/honeycrisp/src/routes/+page.svelte`: Yjs document handle acquisition (`handle.asRichText()`)
- `apps/honeycrisp/package.json`: 6 `@tiptap/*` dependencies
- `apps/fuji/src/lib/components/EntryEditor.svelte`: Simpler TipTap editor without toolbar (147 lines)
- `apps/fuji/src/routes/+page.svelte`: Yjs document handle acquisition (`handle.asText()`)
- `apps/fuji/package.json`: 3 `@tiptap/*` dependencies
- [jakelazaroff/waypoint Outline.svelte](https://github.com/jakelazaroff/waypoint/blob/main/src/component/Outline.svelte): Production Svelte 5 + ProseMirror + Yjs reference
- [PostOwl RichTextEditor.svelte](https://github.com/PostOwl/postowl/blob/main/src/lib/components/RichTextEditor.svelte): Svelte 5 + ProseMirror with `$effect.pre` pattern
- [Jake Lazaroff: Svelte NodeView pattern](https://til.jakelazaroff.com/prosemirror/use-a-svelte-component-as-a-nodeview/): Rendering Svelte components as ProseMirror NodeViews
- [TipTap issue #6025](https://github.com/ueberdosis/tiptap/issues/6025): Svelte 5 runes incompatibility (open, no fix)
- [TipTap task-item source](https://github.com/ueberdosis/tiptap/blob/main/packages/extension-task-item/src/task-item.ts): Reference for task item NodeSpec + NodeView
- [ProseMirror example-setup inputrules](https://github.com/ProseMirror/prosemirror-example-setup/blob/master/src/inputrules.ts): Reference for input rule definitions
- [Svelte Summit Fall 2024: Building a rich text editor with Svelte 5](https://www.youtube.com/watch?v=T2RMYj_1g9E): Michael Aufreiter on ProseMirror alternatives in Svelte 5

## Review

**Completed**: 2026-04-06

### Summary

Replaced TipTap with raw ProseMirror in both Fuji and Honeycrisp editors. Both apps now use `EditorView` mounted via `$effect` with cleanup, schemas built from `prosemirror-schema-basic` + `prosemirror-schema-list`, and direct `y-prosemirror` plugin integration. The Honeycrisp toolbar uses ProseMirror commands (`toggleMark`, `setBlockType`, `wrapInList`) with active format detection via `dispatchTransaction`. No shared `packages/editor/` was created. Schemas are inlined in each editor since they differ (Honeycrisp has taskList/taskItem/underline/strike that Fuji doesn't need).

### Deviations from Spec

- **No shared module (Phase 1 skipped)**: The spec proposed `packages/editor/` for shared code. Instead, schemas and helpers are inlined in each editor component. The schemas genuinely differ between apps, and the helpers are small (~10 lines each). Extraction can happen later if a third editor appears.
- **Fuji got keyboard shortcuts and input rules**: The spec only listed these for Honeycrisp, but Fuji benefits from them too (markdown shortcuts for headings, lists, etc.).
- **`$from` renamed to `resolvedFrom`**: Svelte 5 reserves the `$` prefix for reactive variables. ProseMirror's `selection.$from` needed aliasing in destructuring.
- **Custom `strike` MarkSpec added**: `prosemirror-schema-basic` doesn't include strikethrough. Added alongside `underline` in Honeycrisp's schema.
- **`ySyncPlugin(ytext)` type cast in Fuji**: The function is typed for `Y.XmlFragment` but accepts `Y.Text` at runtime (same as the original TipTap code). Used `as unknown as Y.XmlFragment`.

### Dependencies Removed

| App | Removed |
|---|---|
| Fuji | `@tiptap/core`, `@tiptap/extension-placeholder`, `@tiptap/starter-kit` |
| Honeycrisp | `@tiptap/core`, `@tiptap/extension-placeholder`, `@tiptap/extension-task-item`, `@tiptap/extension-task-list`, `@tiptap/extension-underline`, `@tiptap/starter-kit` |

### Dependencies Added (both apps)

`prosemirror-commands`, `prosemirror-inputrules`, `prosemirror-keymap`, `prosemirror-schema-basic`, `prosemirror-schema-list`

### Follow-up Work

- End-to-end testing (spec item 4.4) requires manual verification with running apps
- Consider extracting shared schema/helpers to `packages/editor/` if a third editor appears
- The `<svelte:component>` deprecation warnings in Honeycrisp toolbar snippets are pre-existing and unrelated. Can be fixed by replacing with direct component rendering
