<script lang="ts">
	import { getEntities } from '$lib/remote/entityIndex.remote';

	let entities = await getEntities();

	function humanizeCreatedAt(v: unknown): string {
		if (v == null) return '';
		const d =
			v instanceof Date ? v : new Date(typeof v === 'number' ? v : Number(v));
		if (Number.isNaN(d.getTime())) return '';
		return d.toLocaleString();
	}

	function detailHref(id: string) {
		return `/entities/${encodeURIComponent(id)}`;
	}
</script>

<h1>Entities</h1>

<nav>
	<a href="/dashboard">Dashboard</a> · <a href="/notes">Notes</a>
</nav>

{#if entities.length === 0}
	<p>No entities.</p>
{:else}
	<table>
		<thead>
			<tr>
				<th>Name</th>
				<th>Type</th>
				<th>Created</th>
				<th>ID</th>
			</tr>
		</thead>
		<tbody>
			{#each entities.toSorted( (a, b) => (a.name ?? '').localeCompare(b.name ?? ''), ) as e}
				<tr>
					<td>
						{#if e.id}
							<a href={detailHref(e.id)}>{e.name ?? '(no name)'}</a>
						{:else}
							{e.name ?? '(no name)'}
						{/if}
					</td>
					<td>{e.type ?? ''}</td>
					<td>{humanizeCreatedAt((e as any).created_at)}</td>
					<td><small style="opacity: 0.7;">{e.id}</small></td>
				</tr>
			{/each}
		</tbody>
	</table>
{/if}

<footer>
	<p><a href="/">Home</a></p>
</footer>
