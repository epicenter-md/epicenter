# Svelte 5: $state Scales Fine, the DOM is the Bottleneck

I benchmarked `$state` with 10,000 rows. Then 100,000. Then a million. The reactive system barely flinched. Here's what I learned.

## The Experiment

Store massive amounts of data in `$state`, but only render a tiny slice:

```svelte
<script>
	const ROW_COUNT = 10000;

	let rows = $state(
		Object.fromEntries(
			Array.from({ length: ROW_COUNT }, (_, i) => [
				`row-${i}`,
				{ title: `Title ${i}`, published: false },
			]),
		),
	);

	function benchmark(iterations = 1000) {
		const start = performance.now();
		for (let i = 0; i < iterations; i++) {
			const rowId = `row-${Math.floor(Math.random() * ROW_COUNT)}`;
			rows[rowId].title = `Bench ${i}`;
		}
		console.log(
			`${iterations} updates in ${(performance.now() - start).toFixed(2)}ms`,
		);
	}
</script>

<!-- Only render 2 rows out of 10,000 -->
{#each Object.entries(rows).slice(0, 2) as [rowId, row] (rowId)}
	<div>{rowId}: {row.title}</div>
{/each}

<button onclick={() => benchmark(1000)}>Benchmark 1000 updates</button>
```

## The Results

| Rows in $state | 1000 random updates | Notes             |
| -------------- | ------------------- | ----------------- |
| 10,000         | ~1-3ms              | Barely noticeable |
| 100,000        | ~2-5ms              | Still fast        |
| 1,000,000      | ~5-15ms             | Svelte handles it |

These numbers are for the **reactive system only**: updating values in memory. The DOM isn't involved because we're updating random rows that aren't rendered.

## $state vs SvelteMap: Almost Identical

I compared both approaches with the same benchmark:

```
$state:     1000 updates in 2.34ms
SvelteMap:  1000 updates in 1.87ms
```

Sometimes `$state` was faster. Sometimes `SvelteMap`. The difference is noise. Both are effectively instant for any realistic workload.

## The Real Bottleneck: DOM Rendering

When I rendered all 10,000 rows? The page crawled. Not because of `$state`, but because browsers struggle with 10,000+ DOM nodes.

The reactive system can handle millions of updates per second. The DOM cannot.

## Copy-Paste Benchmark

Test it yourself in the [Svelte Playground](https://svelte.dev/playground):

```svelte
<script>
	const ROW_COUNT = 10000;

	let rows = $state(
		Object.fromEntries(
			Array.from({ length: ROW_COUNT }, (_, i) => [
				`row-${i}`,
				{ title: `Title ${i}`, published: false },
			]),
		),
	);

	function updateRandomRow() {
		const i = Math.floor(Math.random() * ROW_COUNT);
		rows[`row-${i}`].title = 'Updated ' + Date.now();
	}

	function updateFirst() {
		rows['row-0'].title = 'Updated ' + Date.now();
	}

	function benchmark(iterations = 1000) {
		const start = performance.now();
		for (let i = 0; i < iterations; i++) {
			const rowId = `row-${Math.floor(Math.random() * ROW_COUNT)}`;
			rows[rowId].title = `Bench ${i}`;
		}
		console.log(
			`${iterations} updates in ${(performance.now() - start).toFixed(2)}ms`,
		);
	}
</script>

<h2>$state: {ROW_COUNT} rows (rendering 2)</h2>

<div class="controls">
	<button onclick={updateFirst}>Update row-0 (visible)</button>
	<button onclick={updateRandomRow}>Update random row</button>
	<button onclick={() => benchmark(1000)}>Benchmark 1000 updates</button>
	<button onclick={() => benchmark(10000)}>Benchmark 10000 updates</button>
</div>

<div class="rows">
	{#each Object.entries(rows).slice(0, 2) as [rowId, row] (rowId)}
		<div class="row">
			<strong>{rowId}</strong>
			{#key row.title}
				<span class="cell flash">{row.title}</span>
			{/key}
		</div>
	{/each}
</div>

<p class="info">Data: {ROW_COUNT} rows in memory | DOM: 2 rows rendered</p>

<style>
	.controls {
		margin: 16px 0;
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}
	.row {
		margin: 8px 0;
	}
	.cell {
		padding: 4px 8px;
		margin: 2px;
		display: inline-block;
	}
	.flash {
		animation: flash 0.5s ease-out;
	}
	.info {
		color: #666;
		font-size: 14px;
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

Try changing `ROW_COUNT` to 100000 or even 1000000. The benchmark times stay reasonable. Now try rendering all of them instead of `.slice(0, 2)`. Watch it choke.

## Key Takeaways

1. **`$state` can hold massive datasets.** 10k, 100k, even a million rows. The proxy overhead is negligible.

2. **`$state` vs `SvelteMap` performance is indistinguishable.** Pick based on ergonomics, not speed. (`$state` wins on ergonomics.)

3. **The DOM is the bottleneck.** Always. Svelte's reactive system is not your problem.

4. **Virtualize your lists.** If you have thousands of items, don't render them all. Use windowing/virtualization libraries or render only what's visible.

5. **Don't prematurely optimize the reactive layer.** I spent time comparing `$state` vs `SvelteMap` performance when the real answer was: both are fast, worry about DOM instead.

## The Bottom Line

Store whatever you want in `$state`. Seriously. A million rows? Go for it. Svelte's reactivity handles it.

Just don't try to _render_ a million rows. That's a DOM problem, not a Svelte problem. Use virtualization, pagination, or filtering to keep your rendered DOM small.

The reactive system is not the bottleneck. The DOM is. Always.
