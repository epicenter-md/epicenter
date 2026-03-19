---
name: styling
description: CSS and Tailwind styling guidelines. Use when writing styles, creating UI components, reviewing CSS/Tailwind code, or deciding on wrapper element structure.
metadata:
  author: epicenter
  version: '1.0'
---

# Styling Guidelines

## When to Apply This Skill

Use this pattern when you need to:

- Write Tailwind/CSS for UI components in this repo.
- Decide whether a wrapper element is necessary or can be removed.
- Style interactive disabled states using HTML `disabled` and Tailwind variants.
- Replace JS click guards with semantic disabled behavior.

## Minimize Wrapper Elements

Avoid creating unnecessary wrapper divs. If classes can be applied directly to an existing semantic element with the same outcome, prefer that approach.

### Good (Direct Application)

```svelte
<main class="flex-1 mx-auto max-w-7xl">
	{@render children()}
</main>
```

### Avoid (Unnecessary Wrapper)

```svelte
<main class="flex-1">
	<div class="mx-auto max-w-7xl">
		{@render children()}
	</div>
</main>
```

This principle applies to all elements where the styling doesn't conflict with the element's semantic purpose or create layout issues.

## Tailwind Best Practices

- Use the `cn()` utility from `$lib/utils` for combining classes conditionally
- Prefer utility classes over custom CSS
- Use `tailwind-variants` for component variant systems
- Follow the `background`/`foreground` convention for colors
- Leverage CSS variables for theme consistency

## Disabled States: Use HTML `disabled` + Tailwind Variants

When an interactive element can be non-interactive (empty section, loading state, no items), use the HTML `disabled` attribute instead of JS conditional guards. Pair it with Tailwind's `enabled:` and `group-disabled:` variants.

### Why `disabled` Over JS Guards

- `disabled` natively blocks clicks—no `if (!hasItems) return` needed
- Enables the `:disabled` CSS pseudo-class for styling
- Semantically correct for accessibility (screen readers announce "dimmed" or "unavailable")
- Tailwind's `enabled:` and `group-disabled:` variants compose cleanly

### Pattern

```svelte
<!-- The button disables itself when count is 0 -->
<button
  class="group enabled:cursor-pointer enabled:hover:opacity-80"
  disabled={item.count === 0}
  onclick={toggle}
>
  {item.label} ({item.count})
  <ChevronIcon class="group-disabled:invisible" />
</button>
```

### Key Variants

- `enabled:cursor-pointer` — pointer cursor only when clickable
- `enabled:hover:bg-accent/50` — hover effects only when interactive
- `group-disabled:invisible` — hide child elements (e.g., expand chevron) when parent is disabled
- `disabled:opacity-50` — dim the element when disabled

### Anti-Pattern

```svelte
<!-- Don't do this: JS guard duplicates what disabled does natively -->
<button
  class="cursor-pointer hover:opacity-80"
  onclick={() => { if (item.count > 0) toggle(); }}
>
```

The JS guard leaves `cursor-pointer` and `hover:opacity-80` active on a non-interactive element. The user sees a clickable button that does nothing. Use `disabled` and let the browser + CSS handle it.
