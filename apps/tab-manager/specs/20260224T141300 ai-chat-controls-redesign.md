# AI Chat Controls Area Redesign

## Problem

The bottom controls area of `AiChat.svelte` has several UX and styling issues:

1. **Send button / textarea size mismatch**: The send button uses `size="icon"` (36×36px) but the textarea's natural height doesn't match, creating visual misalignment
2. **Provider + model selects take too much space**: Two full-width selects eat into valuable chat real estate in a narrow sidebar panel
3. **The controls area feels cluttered**: Provider select, model combobox, textarea, and send/stop button all stacked vertically creates a lot of visual noise for a compact sidebar
4. **Missing `<form>` wrapper**: Enter-to-submit works via `onkeydown`, but there's no `<form>` element. Best practice for chat UIs wraps the input area in a `<form>` with `onsubmit` for accessibility and semantic HTML

## Scope

Only the controls area at the bottom of `AiChat.svelte` (lines 188-244). The message list, conversation bar, and error banner are out of scope.

## Design

### 1. Wrap input area in a `<form>` element

Replace the raw `<div>` around textarea + button with a `<form onsubmit>`. This gives us:
- Native form submission semantics (Enter submits, button type="submit")
- Better accessibility (screen readers understand it's a form)
- Cleaner event handling (single `onsubmit` instead of `onkeydown` + `onclick`)

### 2. Fix textarea + send button alignment

- Use `items-end` on the flex row so the send button aligns to the bottom of the textarea
- Set textarea to single-line height by default with `field-sizing-content` (already on the base component) and override `min-h` to match the button height
- Use `size="icon-sm"` (32×32) for the send button to match the compact sidebar context, or explicitly size it with a class

### 3. Collapse provider + model into a single compact row

Instead of two full-width selects, combine them into a tighter layout:
- Show as a single row: `[Provider ▾] [Model ▾]` with smaller text (`text-xs`)
- Both use `size="sm"` for compactness (they already do)
- This is already the current layout; the main improvement is reducing vertical padding

### 4. Tighten vertical spacing

- Reduce `space-y-2` to `space-y-1.5` or `gap-1.5`
- Reduce `px-3 py-2` padding to `px-2 py-1.5` to match the conversation bar above

## Todo

- [ ] Wrap textarea + send button in a `<form>` with `onsubmit` handler
- [ ] Remove redundant `onkeydown` Enter handler (form handles it), keep Shift+Enter for newlines via `e.preventDefault()` on plain Enter
- [ ] Fix send button to self-align to bottom of textarea (`items-end`)
- [ ] Override textarea `min-h` to remove the default `min-h-16` and let `rows={1}` control height
- [ ] Tighten controls area padding and spacing to match conversation bar
- [ ] Verify all functionality: Enter submits, Shift+Enter newline, stop button works, disabled state works

## Non-goals

- Changing the message list or chat bubble components
- Changing the conversation dropdown
- Adding new features (markdown rendering, file attachments, etc.)
