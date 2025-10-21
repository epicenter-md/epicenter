<script lang="ts">
	import { importBundle } from '$lib/remote/vault.remote';
</script>

<h1>Import / Export</h1>

<section>
	<form {...importBundle} enctype="multipart/form-data">
		<h2>Import</h2>
		<div style="margin-top: 0.5rem;">
			<!-- Supports both directory selection and multi-file selection -->
			<input type="file" name="files[]" multiple webkitdirectory />
		</div>
		<div style="margin-top: 0.5rem;">
			<button type="submit" disabled={importBundle.pending > 0}>Import</button>
		</div>
		{#each importBundle.fields.allIssues() as issue}
			<p style="color: red;">{issue.message}</p>
		{/each}
		{#if importBundle.result}
			<p style="color: green;">{importBundle.result.message}</p>
		{/if}
	</form>
</section>

<hr />

<section>
	<h2>Export</h2>
	<div style="margin-top: 0.5rem;">
		<a href="/import-export/export" download>
			<button> Export All (.ZIP)</button>
		</a>
	</div>
</section>

<p>
	<a href="/">Back to Home</a> ·
	<a href="/reddit-upload">Go to Reddit Upload</a>
</p>
