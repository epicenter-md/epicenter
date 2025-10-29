<script lang="ts">
	// Landing page with quickstart
</script>

<h1>Vault Demo</h1>
<p>
	This demo shows a server-backed Vault using Bun SQLite (Drizzle) with adapters
	for Reddit, Entity Index, and Example Notes.
</p>

<h2>Quickstart</h2>
<ol>
	<li>
		Reddit upload:
		<ul>
			<li>Go to <a href="/reddit-upload">Reddit Upload</a>.</li>
			<li>Choose your exported Reddit ZIP and click “Ingest”.</li>
			<li>Click “Suggest entities” to analyze exported rows.</li>
			<li>
				Select the entities you want then click “Import selected into Entity
				Index”. This writes directly to the Entity Index tables via a server
				remote command.
			</li>
		</ul>
	</li>
	<li>
		Browse entities:
		<ul>
			<li>View Entity Index data at <a href="/entities">Entities</a>.</li>
			<li>Click an entity to view its detail page and linked notes.</li>
		</ul>
	</li>
	<li>
		Create and edit notes:
		<ul>
			<li>
				Create a note at <a href="/notes/new">New Note</a> then edit it at
				<a href="/notes">Notes</a>.
			</li>
			<li>
				Use the entity picker to link notes to entities (stored as JSON in the
				notes table).
			</li>
		</ul>
	</li>
	<li>
		Import/Export (optional):
		<ul>
			<li>
				Visit <a href="/import-export">Import/Export</a> to serialize/deserialize
				adapter data bundles.
			</li>
			<li>
				Note: The Reddit entities flow now writes directly; Import is reserved
				for bundle I/O.
			</li>
		</ul>
	</li>
</ol>

<h3>Notes</h3>
<ul>
	<li>Server DB file: apps/vault-demo/.data/vault.sqlite (auto-created).</li>
	<li>
		Row counts for Reddit and Entity Index are visible on the Reddit Upload
		page.
	</li>
</ul>

<h3>Shortcuts</h3>
<ul>
	<li><a href="/reddit-upload">Reddit Upload</a></li>
	<li><a href="/entities">Entities</a></li>
	<li><a href="/notes">Notes</a> · <a href="/notes/new">New Note</a></li>
	<li><a href="/import-export">Import/Export</a></li>
</ul>
