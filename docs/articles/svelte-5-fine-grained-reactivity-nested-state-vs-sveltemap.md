# Svelte 5 Fine-Grained Reactivity: Nested $state vs SvelteMap

I needed cell-level reactivity for a YJS-backed table system. When a single cell changes, only that cell should re-render. Not the entire row or table. Here's what I learned comparing two approaches.

## The Problem

You have tabular data:

```
row-1: { title: "First Post", published: false }
row-2: { title: "Second Post", published: true }
```

When you update `row-1.title`, does Svelte re-render:

- Just the cell showing `row-1.title`? (ideal)
- The entire `row-1`?
- All rows?

## Two Approaches

### Approach 1: `$state` with Nested Objects

```svelte
<script lang="ts">
	let rows = $state({
		'row-1': { title: 'First Post', published: false },
		'row-2': { title: 'Second Post', published: true },
	});

	function updateCell(rowId: string, field: string) {
		if (field === 'published') {
			rows[rowId][field] = !rows[rowId][field];
		} else {
			rows[rowId][field] = 'Updated ' + Date.now();
		}
	}

	// Debug: inspect a specific cell
	$inspect(rows['row-1'].title);
	$inspect(rows['row-1'].published);
	$inspect(rows['row-2'].title);
</script>

{#each Object.entries(rows) as [rowId, row] (rowId)}
	<div>
		<strong>{rowId}</strong>
		<span>{row.title}</span>
		<span>{row.published ? 'Yes' : 'No'}</span>
		<button onclick={() => updateCell(rowId, 'title')}>Update Title</button>
		<button onclick={() => updateCell(rowId, 'published')}>Toggle</button>
	</div>
{/each}
```

**How it works:** Svelte wraps the object in a deep reactive Proxy. Every nested property access is tracked automatically.

### Approach 2: `SvelteMap` of `SvelteMap`

```svelte
<script lang="ts">
	import { SvelteMap } from 'svelte/reactivity';

	const rows = new SvelteMap([
		[
			'row-1',
			new SvelteMap([
				['title', 'First Post'],
				['published', false],
			]),
		],
		[
			'row-2',
			new SvelteMap([
				['title', 'Second Post'],
				['published', true],
			]),
		],
	]);

	function updateCell(rowId: string, field: string) {
		const row = rows.get(rowId)!;
		if (field === 'published') {
			row.set(field, !row.get(field));
		} else {
			row.set(field, 'Updated ' + Date.now());
		}
	}

	// Debug: inspect a specific cell
	$inspect(rows.get('row-1')?.get('title'));
	$inspect(rows.get('row-1')?.get('published'));
	$inspect(rows.get('row-2')?.get('title'));
</script>

{#each [...rows.entries()] as [rowId, row] (rowId)}
	<div>
		<strong>{rowId}</strong>
		<span>{row.get('title')}</span>
		<span>{row.get('published') ? 'Yes' : 'No'}</span>
		<button onclick={() => updateCell(rowId, 'title')}>Update Title</button>
		<button onclick={() => updateCell(rowId, 'published')}>Toggle</button>
	</div>
{/each}
```

**How it works:** `SvelteMap` is a reactive wrapper around native `Map`. Each `.get()` creates an independent subscription.

## The Result: Both Work

When you click "Update Title" on row-1, only the `$inspect` for `rows['row-1'].title` (or `rows.get('row-1')?.get('title')`) fires. The other inspects stay silent.

**The key insight:** Svelte 5's reactivity is fine-grained at the property level for both approaches. You get cell-level precision as long as you:

1. **Mutate in place**: don't spread and replace the whole object
2. **Access specific properties**: don't read the entire object structure unnecessarily

## What Breaks Fine-Grained Reactivity

These patterns create dependencies on the entire data structure:

```typescript
// BAD: reads entire object
const snapshot = { ...rows };
const json = JSON.stringify(rows);

// BAD: iterating creates structural dependency
Object.keys(rows).forEach(...)  // re-runs if keys change

// GOOD: direct property access
rows['row-1'].title  // only tracks this specific path
```

The `{#each Object.entries(rows)}` loop does create a structural dependency on the top-level object, but individual property reads inside the loop are still fine-grained.

## Debugging with `$inspect`

`$inspect` is Svelte 5's built-in debugger for reactivity. It logs whenever the inspected value changes:

```svelte
<script>
	let rows = $state({ 'row-1': { title: 'A', published: false } });

	// Inspect specific cell - only logs when this exact property changes
	$inspect(rows['row-1'].title);

	// Inspect entire row - logs when ANY property in row-1 changes
	$inspect(rows['row-1']);

	// Inspect everything - logs on any change
	$inspect(rows);
</script>
```

For SvelteMap:

```svelte
<script>
	import { SvelteMap } from 'svelte/reactivity';

	const rows = new SvelteMap([
		[
			'row-1',
			new SvelteMap([
				['title', 'A'],
				['published', false],
			]),
		],
	]);

	// Inspect specific cell
	$inspect(rows.get('row-1')?.get('title'));

	// Inspect row (the inner SvelteMap)
	$inspect(rows.get('row-1'));
</script>
```

## Using `$effect` for Granular Tracking

For more surgical debugging, use `$effect` to track exactly which properties trigger re-runs:

```svelte
<script>
	let rows = $state({
		'row-1': { title: 'First Post', published: false },
		'row-2': { title: 'Second Post', published: true },
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

When you update `row-1.title`, you should **only** see `[row-1.title]` in the console. If other effects fire, you have a reactivity leak somewhere.

## Visual Debugging: Flash on Re-render

Console logs are fine, but sometimes you want to _see_ what's re-rendering. Use `{#key}` with a CSS animation:

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
	<div class="row">
		{#key row.title}
			<span class="cell flash">{row.title}</span>
		{/key}
		{#key row.published}
			<span class="cell flash">{row.published}</span>
		{/key}
	</div>
{/each}

<button onclick={updateGranular}>Granular update</button>
<button onclick={replaceWholeRow}>Replace whole row</button>

<style>
	.cell {
		padding: 4px 8px;
		margin: 2px;
		display: inline-block;
	}

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

The `{#key value}` block remounts its contents when `value` changes, retriggering the CSS animation. Cells flash red when they re-render.

## Summary: Which Should You Use?

| Aspect            | `$state` Nested Objects     | `SvelteMap` of `SvelteMap`                                                           |
| ----------------- | --------------------------- | ------------------------------------------------------------------------------------ |
| **Syntax**        | Feels like plain JS objects | Explicit `.get()` / `.set()`                                                         |
| **Reactivity**    | Automatic deep proxy        | Explicit per-key subscriptions                                                       |
| **Fine-grained?** | Yes, at property level      | Yes, at key level                                                                    |
| **Mental model**  | "It just works"             | "I control the boundaries"                                                           |
| **Best for**      | Most use cases              | When you need explicit control or are wrapping Map-like external sources (YJS, etc.) |

For a YJS integration where the underlying data structure is already Map-like, `SvelteMap` aligns more naturally. For general app state, nested `$state` objects are simpler.

## Performance: Is One Faster?

### Theoretical Differences

**`$state` with deep proxies:**

- Every property access goes through the Proxy trap
- Recursive proxification on object creation
- Slightly more memory (proxy wrappers at every level)

**`SvelteMap`:**

- Native Map operations (highly optimized)
- Only the Map itself is reactive, not its contents automatically
- Less memory overhead for deeply nested structures

### Practical Reality

For most applications, the difference is negligible. Both use signals under the hood. The Svelte team has optimized proxy access extensively.

**When it might matter:**

- Tens of thousands of rows with frequent updates
- Hot paths with thousands of property accesses per frame
- Memory-constrained environments with very deep nesting

### How to Benchmark

If you need to know for your specific case:

```svelte
<script>
	import { SvelteMap } from 'svelte/reactivity';

	const ROWS = 10000;
	const ITERATIONS = 1000;

	// Setup: nested $state
	let stateRows = $state(
		Object.fromEntries(
			Array.from({ length: ROWS }, (_, i) => [
				`row-${i}`,
				{ title: `Title ${i}`, published: false },
			]),
		),
	);

	// Setup: SvelteMap
	const mapRows = new SvelteMap(
		Array.from({ length: ROWS }, (_, i) => [
			`row-${i}`,
			new SvelteMap([
				['title', `Title ${i}`],
				['published', false],
			]),
		]),
	);

	function benchmarkState() {
		const start = performance.now();
		for (let i = 0; i < ITERATIONS; i++) {
			const rowId = `row-${Math.floor(Math.random() * ROWS)}`;
			stateRows[rowId].title = `Updated ${i}`;
		}
		console.log(`$state: ${performance.now() - start}ms`);
	}

	function benchmarkMap() {
		const start = performance.now();
		for (let i = 0; i < ITERATIONS; i++) {
			const rowId = `row-${Math.floor(Math.random() * ROWS)}`;
			mapRows.get(rowId)!.set('title', `Updated ${i}`);
		}
		console.log(`SvelteMap: ${performance.now() - start}ms`);
	}
</script>

<button onclick={benchmarkState}>Benchmark $state</button>
<button onclick={benchmarkMap}>Benchmark SvelteMap</button>
```

Run this in your actual environment. The results will depend on your data shape, access patterns, and browser.

> **Real-world result:** I ran this benchmark and found `SvelteMap` to be roughly 2x faster. Often ~1ms vs ~2ms for the same operations. The proxy overhead in `$state` is measurable at scale.

### My Take

Unless you're building a spreadsheet app with 100k+ cells updating in real-time, pick based on ergonomics, not performance. Both are fast enough. The `$state` approach is simpler; `SvelteMap` gives you explicit control when you need it.
