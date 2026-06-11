# Use `disabled` Instead of JS Guards for Non-Interactive States

When a button can't do anything. Zero items to expand, nothing to submit, no action available. Use the HTML `disabled` attribute. Don't write `if (!hasItems) return` inside an `onclick` handler and call it done. The browser already has a mechanism for "this element isn't interactive right now," and it's one attribute.

## The Problem

A collapsible section header with zero items. The button has `cursor-pointer` and `hover:opacity-80`. Clicking it does nothing because the handler checks `if (count === 0) return`. But the user still sees a pointer cursor, still sees the hover effect, and still clicks expecting something to happen.

```svelte
<!-- Looks clickable, does nothing -->
<button
  class="cursor-pointer hover:opacity-80"
  onclick={() => { if (item.count > 0) toggle(); }}
>
  Bookmarks ({item.count})
  <ChevronRight />
</button>
```

The JS guard stops the toggle, but the CSS doesn't know about it. `cursor-pointer` and `hover:opacity-80` apply unconditionally. The element lies to the user.

## The Fix

```svelte
<button
  class="group enabled:cursor-pointer enabled:hover:opacity-80"
  disabled={item.count === 0}
  onclick={toggle}
>
  Bookmarks ({item.count})
  <ChevronRight class="group-disabled:invisible" />
</button>
```

Three things happen when `disabled` is true:

1. The browser blocks the click event natively. No JS guard needed; `toggle` never fires.
2. `enabled:cursor-pointer` and `enabled:hover:opacity-80` deactivate. The element looks and feels non-interactive.
3. `group-disabled:invisible` hides the chevron. There's nothing to expand, so there's no arrow.

When `item.count` goes from 0 to 1, `disabled` is removed and everything reactivates. No state management, no effect cleanup.

## Why Not Just Add `pointer-events-none`?

`pointer-events-none` removes hover and click, but it's a CSS hack over a semantic problem. Screen readers still announce the element as a button. Keyboard navigation still focuses it. `disabled` communicates to the browser, assistive technology, and CSS all at once.

## The Tailwind Variants That Matter

Tailwind provides modifier variants for the `:enabled` and `:disabled` pseudo-classes, and a `group-disabled:` variant for styling children based on a parent's disabled state.

```svelte
<!-- Parent: use enabled: for self-styling -->
<button class="group enabled:cursor-pointer enabled:hover:bg-accent/50" disabled={!canAct}>

<!-- Child: use group-disabled: for parent-aware styling -->
<span class="group-disabled:invisible group-disabled:opacity-0">
  <ChevronRight />
</span>
```

`enabled:` gates the style behind `:enabled`. `group-disabled:` gates the style behind the nearest `group` ancestor's `:disabled` state. Together they replace all the JS guards and conditional class logic.

## Where This Applies

Any element where interactivity depends on a runtime condition: collapsible sections with zero children, submit buttons during validation, textareas that can be readonly, action buttons that depend on selection state. If the condition maps to "this element should not be interactive," `disabled` is the answer.
