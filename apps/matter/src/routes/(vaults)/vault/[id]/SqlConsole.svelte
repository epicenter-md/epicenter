<script lang="ts">
	import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
	import { sql } from '@codemirror/lang-sql';
	import { EditorState } from '@codemirror/state';
	import { EditorView, keymap, placeholder } from '@codemirror/view';
	import * as Alert from '@epicenter/ui/alert';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import * as Empty from '@epicenter/ui/empty';
	import * as Kbd from '@epicenter/ui/kbd';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import { Spinner } from '@epicenter/ui/spinner';
	import * as Table from '@epicenter/ui/table';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import HistoryIcon from '@lucide/svelte/icons/history';
	import PlayIcon from '@lucide/svelte/icons/play';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { untrack } from 'svelte';
	import { CONSOLE_LIMIT } from '$lib/mirror.svelte';
	import type { VaultHandle } from '$lib/vault.svelte';

	// The vault-wide read-only SQL console: run arbitrary SELECT / JOIN / GROUP BY against the vault's
	// hidden `.matter/matter.sqlite` and render the result verbatim. READ-ONLY by construction
	// (ADR-0065): the mirror opens the db read-only, so a write is rejected, and a JOIN or aggregate row
	// maps to no file, so nothing here edits a cell. Cmd/Ctrl+Enter or the Run button executes the
	// editor's text.
	let { vault, defaultTable }: { vault: VaultHandle; defaultTable?: string } =
		$props();

	let container: HTMLDivElement | undefined;
	// Plain handle (not reactive): the Run button reads the live document from it.
	let editorView: EditorView | undefined;
	let result = $state<{ columns: string[]; rows: unknown[][] }>();
	let error = $state<string>();
	let running = $state(false);
	let recentQueries = $state.raw<string[]>([]);

	async function run(text: string): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed || running) return;
		running = true;
		recentQueries = [
			trimmed,
			...recentQueries.filter((query) => query !== trimmed),
		].slice(0, 8);
		const { data, error: failure } = await vault.mirror.runSql(trimmed);
		running = false;
		if (failure) {
			error = failure.message;
			result = undefined;
		} else {
			error = undefined;
			result = data;
		}
	}

	function loadQuery(query: string): void {
		if (!editorView) return;
		editorView.dispatch({
			changes: {
				from: 0,
				to: editorView.state.doc.length,
				insert: query,
			},
		});
		editorView.focus();
	}

	const consoleTheme = EditorView.theme({
		'&': {
			backgroundColor: 'transparent',
			color: 'hsl(var(--foreground))',
			fontSize: '13px',
		},
		'&.cm-focused': { outline: 'none' },
		'.cm-scroller': {
			fontFamily:
				'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
			lineHeight: '1.6',
			overflow: 'auto',
			maxHeight: '14rem',
		},
		'.cm-content': {
			minHeight: '4.5rem',
			padding: '0.75rem 1rem',
			caretColor: 'hsl(var(--foreground))',
		},
		'.cm-cursor': { borderLeftColor: 'hsl(var(--foreground))' },
		'.cm-gutters': { display: 'none' },
		'.cm-activeLine': { backgroundColor: 'transparent' },
		'.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
			backgroundColor: 'hsl(var(--primary) / 0.18)',
		},
		'.cm-placeholder': { color: 'hsl(var(--muted-foreground))' },
	});

	// Seed the editor once with every column of the active table. With no table yet, list the db's
	// tables so even an empty vault shows something runnable. The console mounts fresh for a new
	// active table, so this initial value intentionally does not react afterward.
	$effect(() => {
		if (!container) return;
		const view = new EditorView({
			parent: container,
			state: EditorState.create({
				doc: untrack(() =>
					defaultTable
						? `SELECT * FROM "${defaultTable}" LIMIT 100`
						: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
				),
				extensions: [
					history(),
					keymap.of([
						{
							key: 'Mod-Enter',
							run: (current) => {
								void run(current.state.doc.toString());
								return true;
							},
						},
						...historyKeymap,
						...defaultKeymap,
					]),
					EditorView.lineWrapping,
					sql(),
					placeholder('SELECT * FROM …'),
					consoleTheme,
				],
			}),
		});
		editorView = view;
		return () => {
			view.destroy();
			editorView = undefined;
		};
	});

	/** Render one non-null result cell: an object as compact JSON, everything else as text. NULL and
	 *  undefined never reach here, the template renders them as a faint dash. */
	function renderCell(value: unknown): string {
		if (typeof value === 'object') return JSON.stringify(value);
		return String(value);
	}

	// `runSql` fetches one row past CONSOLE_LIMIT: an overflow row is the capped signal. Render only the
	// first CONSOLE_LIMIT so a result that lands exactly on the limit is not misreported as capped.
	const capped = $derived(!!result && result.rows.length > CONSOLE_LIMIT);
	const rows = $derived(
		capped ? result!.rows.slice(0, CONSOLE_LIMIT) : (result?.rows ?? []),
	);
</script>

<div class="flex min-h-0 flex-1 flex-col">
	<section class="border-b">
		<div class="flex flex-wrap items-center gap-2 border-b px-3 py-2">
			<Badge variant="outline">Read only</Badge>
			<span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">
				Query {vault.folderName}'s SQLite projection
			</span>
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button
							variant="outline"
							size="sm"
							disabled={recentQueries.length === 0}
							{...props}
						>
							<HistoryIcon />
							Recent
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="end" class="w-80">
					<DropdownMenu.Label>Recent queries</DropdownMenu.Label>
					{#each recentQueries as query (query)}
						<DropdownMenu.Item onclick={() => loadQuery(query)}>
							<span class="max-w-72 truncate font-mono text-xs">{query}</span>
						</DropdownMenu.Item>
					{/each}
				</DropdownMenu.Content>
			</DropdownMenu.Root>
			<div class="hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
				<Kbd.Root>⌘/Ctrl</Kbd.Root>
				<span>+</span>
				<Kbd.Root>Enter</Kbd.Root>
			</div>
			<Button
				size="sm"
				onclick={() => run(editorView?.state.doc.toString() ?? '')}
				disabled={running}
			>
				{#if running}<Spinner />{:else}<PlayIcon />{/if}
				{running ? 'Running…' : 'Run query'}
			</Button>
		</div>
		<div
			class="bg-background focus-within:ring-[3px] focus-within:ring-inset focus-within:ring-ring/20"
			bind:this={container}
		></div>
	</section>

	{#if error}
		<Alert.Root variant="destructive" class="rounded-none border-x-0 border-t-0">
			<TriangleAlertIcon />
			<Alert.Title>Query failed</Alert.Title>
			<Alert.Description class="font-mono text-xs">{error}</Alert.Description>
		</Alert.Root>
	{/if}

	<SectionHeader.Root class="flex items-center justify-between gap-3 border-b px-3 py-2">
		<div class="min-w-0">
			<SectionHeader.Title level={2}>Results</SectionHeader.Title>
			<SectionHeader.Description role="status" aria-live="polite">
				{result
					? `Latest query result: ${rows.length} ${rows.length === 1 ? 'row' : 'rows'}${capped ? `, first ${CONSOLE_LIMIT}` : ''}`
					: 'Results appear here after a query runs'}
			</SectionHeader.Description>
		</div>
		{#if result}
			<Badge variant="secondary">
				{rows.length} {rows.length === 1 ? 'row' : 'rows'}{#if capped} · first {CONSOLE_LIMIT}{/if}
			</Badge>
		{/if}
	</SectionHeader.Root>

	<div class="min-h-0 flex-1 overflow-auto">
		{#if result}
			{#if rows.length === 0}
				<Empty.Root class="min-h-full border-0">
					<Empty.Media variant="icon"><DatabaseIcon /></Empty.Media>
					<Empty.Title>No rows</Empty.Title>
					<Empty.Description>The query ran but returned no rows.</Empty.Description>
				</Empty.Root>
			{:else}
				<Table.Root class="min-w-full">
					<Table.Header>
						<Table.Row>
							{#each result.columns as column, i (i)}
								<Table.Head class="sticky top-0 z-10 bg-background font-mono text-xs">
									{column}
								</Table.Head>
							{/each}
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each rows as row, r (r)}
							<Table.Row>
								{#each row as cell, c (c)}
									<Table.Cell class="max-w-80 truncate font-mono text-xs">
										{#if cell === null || cell === undefined}
											<span class="text-muted-foreground/50">.</span>
										{:else}
											{renderCell(cell)}
										{/if}
									</Table.Cell>
								{/each}
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			{/if}
		{:else if error}
			<Empty.Root class="min-h-full border-0">
				<Empty.Media variant="icon"><TriangleAlertIcon /></Empty.Media>
				<Empty.Title>No result</Empty.Title>
				<Empty.Description>Fix the query above and run it again.</Empty.Description>
			</Empty.Root>
		{:else}
			<Empty.Root class="min-h-full border-0">
				<Empty.Media variant="icon"><DatabaseIcon /></Empty.Media>
				<Empty.Title>Ready to query</Empty.Title>
				<Empty.Description>
					Run the starter query, or write a JOIN across tables.
				</Empty.Description>
			</Empty.Root>
		{/if}
	</div>
</div>
