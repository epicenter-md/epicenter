<script lang="ts">
	import {
		extractEntitiesFromReddit,
		type ExtractedEntity,
		type ExtractedOccurrence,
	} from '$lib/extract/redditEntities';
	import { insertEntities } from '$lib/remote/entityIndex.remote';

	let selectedFile: File | null = null;
	let isPending = false;
	let isSuggesting = false;
	let status: { kind: 'idle' | 'success' | 'error'; message: string } = {
		kind: 'idle',
		message: '',
	};

	type Count = { table: string; count: number };
	let counts: Count[] = [];
	let entityIndexCounts: Count[] = [];

	type Suggestions = {
		entities: ExtractedEntity[];
		occurrences: ExtractedOccurrence[];
	};
	let suggestions: Suggestions | null = null;
	let selectedEntityIds = new Set<string>();

	function onFileChange(e: Event) {
		const input = e.target as HTMLInputElement;
		selectedFile = input.files?.[0] ?? null;
	}

	function setCountsFromMap(map: Record<string, Record<string, number>>) {
		const reddit = map?.reddit ?? {};
		const entityIndex = map?.entity_index ?? {};
		counts = Object.entries(reddit)
			.map(([table, count]) => ({ table, count: Number(count) }))
			.sort((a, b) => a.table.localeCompare(b.table));
		entityIndexCounts = Object.entries(entityIndex)
			.map(([table, count]) => ({ table, count: Number(count) }))
			.sort((a, b) => a.table.localeCompare(b.table));
	}

	async function refreshCounts() {
		try {
			const res = await fetch('/api/vault/counts');
			const data = (await res.json()) as {
				ok: boolean;
				counts?: Record<string, Record<string, number>>;
			};
			if (data?.ok && data.counts) {
				setCountsFromMap(data.counts);
			}
		} catch {
			// ignore
		}
	}

	async function handleIngest(ev: SubmitEvent) {
		ev.preventDefault();
		status = { kind: 'idle', message: '' };
		isPending = true;

		try {
			const formEl = ev.currentTarget as HTMLFormElement;
			const fd = new FormData(formEl);

			const res = await fetch('/api/vault/ingest?adapter=reddit', {
				method: 'POST',
				body: fd,
			});

			const data = (await res.json()) as {
				ok: boolean;
				counts?: Record<string, Record<string, number>>;
				error?: string;
			};
			if (!data.ok) {
				throw new Error(data.error || 'Ingest failed');
			}

			if (data.counts) setCountsFromMap(data.counts);

			status = {
				kind: 'success',
				message: selectedFile
					? `Ingested '${selectedFile.name}'`
					: 'Ingested file',
			};
			formEl.reset();
			selectedFile = null;
		} catch (err) {
			status = {
				kind: 'error',
				message: err instanceof Error ? err.message : String(err),
			};
		} finally {
			isPending = false;
		}
	}

	async function suggestEntities() {
		isSuggesting = true;
		status = { kind: 'idle', message: '' };
		// Build in-memory tables from exported reddit files
		const tablesToRows: Record<string, Record<string, unknown>[]> = {};
		try {
			const res = await fetch('/api/vault/export');
			const data = (await res.json()) as {
				ok: boolean;
				files?: Array<{ path: string; text: string; mimeType: string }>;
				error?: string;
			};
			if (!data.ok || !data.files) {
				throw new Error(data.error || 'Export failed');
			}
			let scanned = 0;
			let matched = 0;
			for (const f of data.files) {
				scanned++;
				const path = f.path;
				const parts = path.split('/').filter(Boolean);
				// Find adapter segment anywhere in the path (supports vault/adapter/table/... and adapter/table/...)
				const aIdx = parts.findIndex((p) => p === 'reddit');
				if (aIdx === -1) {
					continue; // not a reddit file
				}
				matched++;
				const tableName = parts[aIdx + 1];
				if (!tableName) continue;

				try {
					const row = JSON.parse(f.text) as Record<string, unknown>;
					let arr = tablesToRows[tableName];
					if (!arr) {
						arr = [];
						tablesToRows[tableName] = arr;
					}
					arr.push(row);
				} catch {
					// skip bad rows
				}
			}

			suggestions = extractEntitiesFromReddit(tablesToRows);
			selectedEntityIds = new Set(
				(suggestions?.entities ?? []).map((e) => e.id),
			);

			const entCount = suggestions?.entities?.length ?? 0;
			const occCount = suggestions?.occurrences?.length ?? 0;
			status = {
				kind: 'success',
				message:
					entCount === 0 && occCount === 0
						? `Scanned ${scanned} files (${matched} reddit); no entities found`
						: `Scanned ${scanned} files (${matched} reddit); suggested ${entCount} entities and ${occCount} occurrences`,
			};
		} catch (err) {
			status = {
				kind: 'error',
				message: err instanceof Error ? err.message : String(err),
			};
		} finally {
			isSuggesting = false;
		}
	}

	function toggleSelected(id: string, checked: boolean) {
		if (checked) {
			selectedEntityIds.add(id);
		} else {
			selectedEntityIds.delete(id);
		}
		selectedEntityIds = new Set(selectedEntityIds);
	}

	async function importSelected() {
		if (!suggestions) {
			status = { kind: 'error', message: 'No suggestions to import' };
			return;
		}
		isPending = true;
		status = { kind: 'idle', message: '' };
		try {
			const chosenEntities: ExtractedEntity[] = suggestions.entities.filter(
				(e) => selectedEntityIds.has(e.id),
			);
			const chosenOccurrences: ExtractedOccurrence[] =
				suggestions.occurrences.filter((o) =>
					chosenEntities.some((e) => e.id === o.entity_id),
				);

			// Insert directly via remote function (bypasses import pipeline)
			await insertEntities({
				entities: chosenEntities.map((e) => ({
					id: e.id,
					name: e.name ?? null,
					type: e.type ?? null,
					description: e.description ?? null,
					public_id: e.public_id ?? null,
					created_at: e.created_at,
				})),
				occurrences: chosenOccurrences.map((o) => ({
					id: o.id,
					entity_id: o.entity_id,
					source_adapter_id: o.source_adapter_id,
					source_table_name: o.source_table_name,
					source_pk_json: o.source_pk_json,
					discovered_at: o.discovered_at,
				})),
			});

			await refreshCounts();
			status = {
				kind: 'success',
				message: `Imported ${chosenEntities.length} entities and ${chosenOccurrences.length} occurrences`,
			};
		} catch (err) {
			status = {
				kind: 'error',
				message: err instanceof Error ? err.message : String(err),
			};
		} finally {
			isPending = false;
		}
	}
</script>

<h1>Reddit Upload</h1>

<form
	enctype="multipart/form-data"
	on:submit={handleIngest}
	style="margin: 0.5rem 0;"
>
	<input type="file" name="file" on:change={onFileChange} />
	<div style="margin-top: 0.5rem;">
		<button type="submit" disabled={!selectedFile || isPending}>
			{#if isPending}Ingesting...{:else}Ingest{/if}
		</button>
	</div>
</form>

<div style="margin: 0.5rem 0;">
	<button on:click={suggestEntities} disabled={isPending || isSuggesting}>
		{#if isSuggesting}Analyzing…{:else}Suggest entities{/if}
	</button>
	{#if suggestions}
		<button
			on:click={importSelected}
			disabled={isPending || selectedEntityIds.size === 0}
			style="margin-left: 0.5rem;"
		>
			Import selected into Entity Index
		</button>
	{/if}
</div>

{#if status.kind === 'success'}
	<p style="color: green;">{status.message}</p>
{:else if status.kind === 'error'}
	<p style="color: red;">{status.message}</p>
{/if}

{#if suggestions}
	<h2>Suggested Entities</h2>

	<div>
		<h3>Subreddits</h3>
		<ul>
			{#each suggestions.entities.filter((e) => e.type === 'subreddit') as e}
				<li>
					<label>
						<input
							type="checkbox"
							checked={selectedEntityIds.has(e.id)}
							on:change={(ev) =>
								toggleSelected(e.id, (ev.target as HTMLInputElement).checked)}
						/>
						{e.name} <small style="opacity: 0.7;">({e.id})</small>
					</label>
				</li>
			{/each}
		</ul>
	</div>

	<div>
		<h3>Users</h3>
		<ul>
			{#each suggestions.entities.filter((e) => e.type === 'user') as e}
				<li>
					<label>
						<input
							type="checkbox"
							checked={selectedEntityIds.has(e.id)}
							on:change={(ev) =>
								toggleSelected(e.id, (ev.target as HTMLInputElement).checked)}
						/>
						{e.name} <small style="opacity: 0.7;">({e.id})</small>
					</label>
				</li>
			{/each}
		</ul>
	</div>

	<div>
		<h3>Domains</h3>
		<ul>
			{#each suggestions.entities.filter((e) => e.type === 'domain') as e}
				<li>
					<label>
						<input
							type="checkbox"
							checked={selectedEntityIds.has(e.id)}
							on:change={(ev) =>
								toggleSelected(e.id, (ev.target as HTMLInputElement).checked)}
						/>
						{e.name} <small style="opacity: 0.7;">({e.id})</small>
					</label>
				</li>
			{/each}
		</ul>
	</div>
{/if}

{#if counts.length > 0}
	<h2>Reddit Tables</h2>
	<ul>
		{#each counts as c}
			<li>{c.table}: {c.count}</li>
		{/each}
	</ul>
{/if}

{#if entityIndexCounts.length > 0}
	<h2>Entity Index Tables</h2>
	<ul>
		{#each entityIndexCounts as c}
			<li>{c.table}: {c.count}</li>
		{/each}
	</ul>
{/if}

<p>
	<a href="/">Back to Home</a> ·
	<a href="/import-export">Go to Import/Export</a>
</p>
