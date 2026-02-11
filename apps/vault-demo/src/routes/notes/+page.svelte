<script lang="ts">
	import { onMount } from 'svelte';
	import { getNotes } from '$lib/remote/notes.remote';
	import type { NoteView } from '$lib/schemas/notes';

	let search = '';
	let notes: NoteView[] = [];
	let filtered: NoteView[] = [];
	let isLoaded = false;
	let errorText = '';

	function humanizeDate(v: unknown): string {
		if (v == null) return '';
		const d =
			v instanceof Date ? v : new Date(typeof v === 'number' ? v : Number(v));
		if (Number.isNaN(d.getTime())) return '';
		return d.toLocaleString();
	}

	onMount(async () => {
		try {
			const result = await getNotes();
			notes = result ?? [];
		} catch (err) {
			errorText = err instanceof Error ? err.message : String(err);
		} finally {
			isLoaded = true;
		}
	});

	$: {
		const q = search.trim().toLowerCase();
		filtered = q
			? notes.filter(
					(n) =>
						(n.title ?? '').toLowerCase().includes(q) ||
						(n.body ?? '').toLowerCase().includes(q),
				)
			: notes;
	}
</script>

<h1>Notes</h1>

<nav>
	<a href="/dashboard">Dashboard</a> · <a href="/entities">Entities</a> ·
	<a href="/notes/new">New</a>
</nav>

<div style="margin: 0.5rem 0;">
	<input
		type="search"
		placeholder="Search notes…"
		bind:value={search}
		style="width: 100%; max-width: 420px;"
	/>
</div>

{#if !isLoaded}
	<p>Loading…</p>
{:else if errorText}
	<p style="color:red;">{errorText}</p>
{:else if notes.length === 0}
	<p>No notes found.</p>
{:else}
	<ul>
		{#each filtered as n}
			<li style="margin-bottom: 0.5rem;">
				<strong>
					<a href={`/notes/${encodeURIComponent(n.id)}`}
						>{n.title || '(untitled)'}</a
					>
				</strong>
				<small style="opacity:0.7;">— {humanizeDate(n.created_at)}</small>
				{#if n.entity_links.length > 0}
					<div
						style="margin-top: 0.25rem; display: flex; gap: 0.25rem; flex-wrap: wrap;"
					>
						{#each n.entity_links as eid}
							<a
								href={`/entities/${encodeURIComponent(eid)}`}
								style="display:inline-block; padding: 0.1rem 0.4rem; background:#eef; border-radius: 999px; font-size: 0.85rem;"
							>
								{eid}
							</a>
						{/each}
					</div>
				{/if}
			</li>
		{/each}
	</ul>
{/if}

<footer>
	<p><a href="/">Home</a></p>
</footer>
