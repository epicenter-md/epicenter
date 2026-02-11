<script lang="ts">
	import { getEntities } from '$lib/remote/entityIndex.remote';
	import { createNote } from '$lib/remote/notes.remote';

	const entities = await getEntities();
</script>

<h1>New Note</h1>

<nav>
	<a href="/notes">Back to Notes</a> · <a href="/entities">Entities</a> ·
	<a href="/dashboard">Dashboard</a>
</nav>

<form
	{...createNote}
	style="display:flex; flex-direction: column; gap: 0.75rem; max-width: 680px;"
>
	<label>
		<div>Title</div>
		<input
			{...createNote.fields.title.as('text')}
			placeholder="Note title"
			required
		/>
	</label>

	<label>
		<div>Body</div>
		<textarea
			{...createNote.fields.body.as('text')}
			rows="6"
			placeholder="Write your note..."
		></textarea>
	</label>

	<fieldset style="border: 1px solid #e5e7eb; padding: 0.75rem;">
		<legend>Link to Entities</legend>
		{#if entities.length === 0}
			<p style="margin:0;">No entities available.</p>
		{:else}
			<div
				style="display:grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 0.25rem;"
			>
				{#each entities as e}
					<label style="display:flex; gap: 0.5rem; align-items: center;">
						<input {...createNote.fields.entity_links.as('checkbox', e.id)} />
						<span>{e.name ?? e.id}</span>
					</label>
				{/each}
			</div>
		{/if}
	</fieldset>

	<div style="display:flex; gap: 0.5rem;">
		<button type="submit" disabled={createNote.pending > 0}>
			{#if createNote.pending}Creating…{:else}Create{/if}
		</button>
		<a href="/notes">Cancel</a>
	</div>

	{#each createNote.fields.allIssues() as issue}
		<p style="color: red;">{issue.message}</p>
	{/each}
</form>

<footer style="margin-top: 1rem;">
	<p><a href="/">Home</a></p>
</footer>
