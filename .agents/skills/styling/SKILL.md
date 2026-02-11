---
name: styling
description: CSS and Tailwind styling guidelines. Use when writing styles, creating UI components, reviewing CSS/Tailwind code, or deciding on wrapper element structure.
---

# Styling Guidelines

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
