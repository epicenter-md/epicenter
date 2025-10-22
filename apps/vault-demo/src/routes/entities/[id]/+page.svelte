<script lang="ts">
	import { page } from '$app/state';
	import { getEntityById } from '$lib/remote/entityIndex.remote';
	import { getNotes } from '$lib/remote/notes.remote';

	let id = $derived(page.params.id ?? '');
	let entity = $derived(await getEntityById({ id }));
	let allNotes = await getNotes();
	let linkedNotes = $derived(
		allNotes.filter((n) => n.entity_links.includes(id)),
	);

	function humanizeDate(v: unknown): string {
		if (v == null) return '';
		const d =
			v instanceof Date ? v : new Date(typeof v === 'number' ? v : Number(v));
		if (Number.isNaN(d.getTime())) return '';
		return d.toLocaleString();
	}
</script>

<h1>Entity Detail</h1>

<nav>
	<a href="/entities">Back to Entities</a> · <a href="/dashboard">Dashboard</a>
	· <a href="/notes">Notes</a>
</nav>

<section>
	<h2>
		{entity.name ?? '(no name)'}
		<small style="opacity:0.7;">({entity.id})</small>
	</h2>
	<ul>
		<li>Type: {entity.type ?? ''}</li>
		<li>Public ID: {(entity as any).public_id ?? ''}</li>
		<li>Created: {humanizeDate((entity as any).created_at)}</li>
		<li>Description: {(entity as any).description ?? ''}</li>
	</ul>
</section>

<section>
	<h3>Linked Notes</h3>
	{#if linkedNotes.length === 0}
		<p>No linked notes.</p>
	{:else}
		<ul>
			{#each linkedNotes as n}
				<li>
					<a href={`/notes/${encodeURIComponent(n.id)}`}>
						<strong>{n.title || '(untitled)'}</strong>
					</a>
					<small style="opacity:0.7;"> — {humanizeDate(n.created_at)}</small>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<footer>
	<p><a href="/">Home</a></p>
</footer>
