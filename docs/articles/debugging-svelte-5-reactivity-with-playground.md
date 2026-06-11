# Debugging Svelte 5 Reactivity: Adventures in the Playground

I spent time in the Svelte playground figuring out exactly how fine-grained reactivity works with nested state. Here's what I learned and the techniques that helped.

## The Question

When you have nested objects in `$state`:

```typescript
let rows = $state({
	'row-1': { title: 'First', published: false },
	'row-2': { title: 'Second', published: true },
});
```

And you update a single property:

```typescript
rows['row-1'].title = 'Updated';
```

What actually re-renders? Just that cell? The whole row? Everything?

## Debugging Technique 1: `$inspect` at Different Levels

`$inspect` logs whenever the observed value changes. The key insight: **what you observe determines what triggers it**.

```svelte
<script>
	let rows = $state({
		'row-1': { title: 'First', published: false },
		'row-2': { title: 'Second', published: true },
	});

	// Fires on ANY change anywhere in rows
	$inspect(rows);

	// Fires only when row-1.title changes
	$inspect(rows['row-1'].title);

	// Fires only when row-1.published changes
	$inspect(rows['row-1'].published);

	// Fires only when row-2.title changes
	$inspect(rows['row-2'].title);
</script>
```

When I updated `rows['row-1'].title`:

- `$inspect(rows)` fired (watching everything)
- `$inspect(rows['row-1'].title)` fired (this changed)
- `$inspect(rows['row-1'].published)` stayed silent
- `$inspect(rows['row-2'].title)` stayed silent

This confirmed: Svelte tracks at the property level, not the object level.

## Debugging Technique 2: `$effect` Per Property

For more explicit tracking:

```svelte
<script>
	let rows = $state({
		'row-1': { title: 'First', published: false },
		'row-2': { title: 'Second', published: true },
	});

	$effect(() => {
		console.log('[row-1.title]', rows['row-1'].title);
	});

	$effect(() => {
		console.log('[row-1.published]', rows['row-1'].published);
	});

	$effect(() => {
		console.log('[row-2.title]', rows['row-2'].title);
	});
</script>
```

Same result: only the effect reading the changed property runs.

## Debugging Technique 3: Flash Red on Re-render

Console logs are fine, but I wanted to _see_ it. This technique uses `{#key}` to remount elements when values change, triggering a CSS animation:

```svelte
<script>
	let rows = $state({
		'row-1': { title: 'First', published: false },
		'row-2': { title: 'Second', published: true },
	});

	function updateGranular() {
		rows['row-1'].title = 'Updated ' + Date.now();
	}

	function replaceWholeRow() {
		rows['row-1'] = { ...rows['row-1'], title: 'Replaced ' + Date.now() };
	}
</script>

{#each Object.entries(rows) as [rowId, row] (rowId)}
	<div>
		{#key row.title}
			<span class="flash">{row.title}</span>
		{/key}
		{#key row.published}
			<span class="flash">{row.published}</span>
		{/key}
	</div>
{/each}

<button onclick={updateGranular}>Granular update</button>
<button onclick={replaceWholeRow}>Replace whole row</button>

<style>
	.flash {
		animation: flash 0.5s ease-out;
	}

	@keyframes flash {
		0% {
			background: red;
		}
		100% {
			background: transparent;
		}
	}
</style>
```

Now I could literally see which cells flash red when I click buttons.

## The Surprising Discovery

I expected "Replace whole row" to flash both cells in row-1 (title and published). But only the title flashed.

Why? Svelte is smart. Even though I replaced the entire row object:

```typescript
rows['row-1'] = { ...rows['row-1'], title: 'Replaced ' + Date.now() };
```

Svelte's reactivity system diffs the values. Since `published` had the same value (`false`) before and after, Svelte didn't consider it "changed" for rendering purposes.

This is the proxy doing intelligent diffing under the hood. It's not just checking "did this object reference change". It's checking "did this _value_ actually change."

## Key Takeaways

1. **Svelte 5 reactivity is fine-grained at the property level.** Updating `rows['row-1'].title` only affects things reading that exact property.

2. **`$inspect(rows)` firing doesn't mean everything re-renders.** It means you're _observing_ the whole tree. The template still has granular subscriptions.

3. **Replacing an object doesn't necessarily re-render all its children.** Svelte diffs values. If a property's value is unchanged, it won't trigger updates for that property.

4. **Use `{#key}` + CSS animations to visualize re-renders.** Much more intuitive than console logs.

5. **The playground is your friend.** These behaviors are easier to understand when you can see them in action.

## Debugging Checklist

When investigating reactivity:

| Technique                     | What it tells you                     |
| ----------------------------- | ------------------------------------- |
| `$inspect(specific.path)`     | When this exact value changes         |
| `$inspect(wholeObject)`       | When anything in the tree changes     |
| `$effect(() => value)`        | When this reactive expression re-runs |
| `{#key value}` + CSS flash    | When this DOM element remounts        |
| Component with render counter | How many times a component re-renders |

## The Mental Model

Think of Svelte's reactivity like a spreadsheet. Each cell has its own formula. Changing cell A1 only recalculates cells that reference A1. Changing A1 doesn't recalculate B1 just because they're in the same row.

Your `$state` object is the spreadsheet. Each property access (`rows['row-1'].title`) is a cell reference. Svelte tracks which "cells" each piece of UI depends on and only updates what's necessary.
