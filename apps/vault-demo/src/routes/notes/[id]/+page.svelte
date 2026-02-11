<script lang="ts">
	import { page } from '$app/state';
	import { getEntities } from '$lib/remote/entityIndex.remote';
	import {
		deleteNote,
		getNoteById,
		updateNote,
	} from '$lib/remote/notes.remote';

	let id = $derived(page.params.id ?? '');
	let note = $derived(await getNoteById({ id }));
	let entities = await getEntities();
</script>

<h1>Edit Note</h1>

<nav>
	<a href="/notes">Back to Notes</a> · <a href="/dashboard">Dashboard</a>
</nav>

<!-- https://github.com/sveltejs/kit/issues/14729 -->
<form
	{...updateNote}
	style="display:flex; flex-direction: column; gap: 0.75rem; max-width: 760px;"
>
	<input {...updateNote.fields.id.as('hidden', id)} />

	<label>
		<div>Title</div>
		<input
			{...updateNote.fields.title.as('text')}
			value={note.title}
			placeholder="Note title"
			required
		/>
	</label>

	<label>
		<div>Body</div>
		<textarea
			{...updateNote.fields.body.as('text')}
			value={note.body}
			rows="10"
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
						<input
							{...updateNote.fields.entity_links.as('checkbox', e.id)}
							checked={note.entity_links.includes(e.id)}
						/>
						<span>{e.name ?? e.id}</span>
					</label>
				{/each}
			</div>
		{/if}
	</fieldset>

	<div>
		<button type="submit">Save</button>
	</div>

	{#if updateNote.fields.allIssues()}
		<p style="color: red;">{updateNote.fields.allIssues()?.[0].message}</p>
	{/if}
</form>
<form {...deleteNote} style="margin-top: 1rem;">
	<input {...deleteNote.fields.id.as('hidden', note.id)} />
	<input type="submit" value="Delete" style="color:red;" />
</form>

<footer style="margin-top: 1rem;">
	<p><a href="/">Home</a></p>
</footer>
