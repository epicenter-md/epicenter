<script lang="ts">
	import { getCounts } from '$lib/remote/vault.remote';

	type TableCount = { table: string; count: number };
	type CountsByAdapter = Record<string, TableCount[]>;

	let countsByAdapter: CountsByAdapter = {};
	let adapterIds: string[] = [];

	async function loadCounts() {
		try {
			const map = await getCounts(); // Record<string, Record<string, number>>
			const result: CountsByAdapter = {};
			for (const [adapterId, tableMap] of Object.entries(map ?? {})) {
				const entries = Object.entries(tableMap ?? {})
					.map(([table, count]) => ({ table, count: Number(count) }))
					.sort((a, b) => a.table.localeCompare(b.table));
				result[adapterId] = entries;
			}
			countsByAdapter = result;
			adapterIds = Object.keys(result).sort();
		} catch {
			countsByAdapter = {};
			adapterIds = [];
		}
	}

	loadCounts();
</script>

<h1>Dashboard</h1>

<nav>
	<a href="/entities">Entities</a> · <a href="/notes">Notes</a>
</nav>

{#if adapterIds.length === 0}
	<p>No adapters found.</p>
{:else}
	{#each adapterIds as adapterId}
		<section>
			<h2>{adapterId}</h2>
			{#if (countsByAdapter[adapterId]?.length ?? 0) === 0}
				<p>No tables.</p>
			{:else}
				<ul>
					{#each countsByAdapter[adapterId] as c}
						<li>{c.table}: {c.count}</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/each}
{/if}

<footer>
	<p><a href="/">Home</a></p>
</footer>
