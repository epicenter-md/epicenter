<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import * as Table from '@epicenter/ui/table';
	import * as ToggleGroup from '@epicenter/ui/toggle-group';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import FileWarningIcon from '@lucide/svelte/icons/file-warning';
	import ListIcon from '@lucide/svelte/icons/list';
	import ListFilterIcon from '@lucide/svelte/icons/list-filter';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import type { Kind } from '@epicenter/field';
	import type { Cell } from '$lib/core/conformance';
	import type { FolderGridVault } from '$lib/vault.svelte';
	import ModeledCell from './ModeledCell.svelte';
	import RowDetailDialog from './RowDetailDialog.svelte';

	// The grid renders from any {@link FolderGridVault}: the live disk vault or the
	// in-memory demo vault, injected by the route. The narrow getters are bound once
	// here so the template reads `read` / `folder` / `onSave*` exactly as before, and a
	// vault swap (open another folder) flows through these derivations.
	// `matchedFileNames` is the file names of the rows a WHERE clause matched, computed by
	// the page (the live-vault owner) and handed down as data. `undefined` means no filter.
	let { vault, matchedFileNames }: { vault: FolderGridVault; matchedFileNames?: Set<string> } =
		$props();

	const read = $derived(vault.read);
	const folder = $derived(vault.folderName);
	const onSaveField = $derived(vault.saveField);
	const onSaveBody = $derived(vault.saveBody);
	const view = $derived(read.view);

	type RowFilter = 'all' | 'attention';

	// The attention filter is a view mode over the same table, not a relayout.
	let rowFilter = $state<RowFilter>('all');

	const visibleRows = $derived.by(() => {
		if (view.mode !== 'modeled') return [];
		let rows =
			rowFilter === 'attention'
				? view.conformance.filter((c) => !c.rowValid)
				: view.conformance;
		// The WHERE filter (matched row file names from the mirror, computed by the page)
		// narrows the visible set; no active filter leaves it undefined, nothing to do. The
		// local alias is load-bearing: it narrows `Set | undefined` to `Set` in the closure.
		const fileNames = matchedFileNames;
		if (fileNames) rows = rows.filter((c) => fileNames.has(c.row.fileName));
		return rows;
	});

	// "X of Y rows" whenever a lens is narrowing the table (attention OR a WHERE clause).
	const isFiltered = $derived(rowFilter === 'attention' || matchedFileNames !== undefined);

	// The modeled empty-state copy as ONE mutually exclusive decision, so the title and the
	// description always describe the same case. Reads top-down like the question a person
	// asks ("is a filter on? is attention on? otherwise it is just empty") instead of two
	// nested ternaries in the markup that have to be kept in sync by hand.
	const emptyState = $derived.by(() => {
		if (matchedFileNames)
			return {
				title: 'No rows match the filter',
				description: 'No valid rows match this WHERE clause.',
			};
		if (rowFilter === 'attention')
			return {
				title: 'No rows need attention',
				description: 'Every readable row matches this model.',
			};
		return {
			title: 'No rows yet',
			description: 'Add markdown files with frontmatter to see them here.',
		};
	});

	const needsAttentionCount = $derived(
		view.mode === 'modeled' ? view.conformance.filter((c) => !c.rowValid).length : 0,
	);

	let detailOpen = $state(false);
	let detailFileName = $state<string>();
	const detailConformance = $derived.by(() => {
		if (view.mode !== 'modeled' || !detailFileName) return undefined;
		return view.conformance.find((conf) => conf.row.fileName === detailFileName);
	});

	// Per-kind column width: the `<col>` basis under `table-fixed`, so the grid reads
	// like a spreadsheet (a number column a third the width of a tags column) instead
	// of ten equal slabs. Keyed on `field.kind`, the stable discriminant, so sizing is
	// semantic, not positional: no "the first column is the title" guess. `satisfies
	// Record<Kind, string>` makes a new palette kind fail to compile until it has a
	// width here, the same exhaustiveness gate the widget registry carries.
	const COLUMN_WIDTH = {
		string: 'w-56',
		url: 'w-56',
		datetime: 'w-44',
		select: 'w-40',
		integer: 'w-24',
		number: 'w-24',
		boolean: 'w-20',
		tags: 'w-64',
		multiSelect: 'w-64',
		json: 'w-64',
	} satisfies Record<Kind, string>;

	// Numerics right-align so digits line up down the column edge; booleans center
	// their checkbox; everything else reads left. The SAME numeric/boolean decision
	// drives the cell's text-align AND the header's cross-axis (the header stacks the
	// field name over its kind and matches the column, so a narrow numeric column's
	// name stays readable), so it lives in one place read out as `.cell` / `.head`
	// rather than duplicated across two functions that must move together.
	function columnAlign(kind: Kind): { cell: string; head: string } {
		if (kind === 'integer' || kind === 'number')
			return { cell: 'text-right', head: 'items-end' };
		if (kind === 'boolean') return { cell: 'text-center', head: 'items-center' };
		return { cell: '', head: 'items-start' };
	}

	// A cell out of conformance carries its state as an inset ring: amber for an empty
	// required cell, destructive for an out-of-domain value. The ring lives on the
	// CELL, not the row, so one signal owns "this needs attention" instead of stacking
	// a row tint under a cell tint under the hover tint.
	function cellStateClass(state: Cell['state']): string {
		if (state === 'NEEDS_VALUE') {
			return 'bg-amber-500/5 ring-1 ring-inset ring-amber-500/30';
		}

		if (state === 'INVALID') {
			return 'bg-destructive/5 ring-1 ring-inset ring-destructive/30';
		}

		return '';
	}

	$effect(() => {
		if (!detailOpen) {
			detailFileName = undefined;
			return;
		}

		if (detailFileName && !detailConformance) {
			detailOpen = false;
			detailFileName = undefined;
		}
	});
</script>

<!-- Raw value render for the unmodeled view: plain text, no type guessing. -->
{#snippet rawValue(value: unknown)}
	{#if value === null || value === undefined}
		<span class="text-muted-foreground/50">.</span>
	{:else if Array.isArray(value)}
		<div class="flex flex-wrap gap-1">
			{#each value as item, i (i)}
				<Badge variant="secondary" class="max-w-44 truncate">
					{typeof item === 'object' ? JSON.stringify(item) : String(item)}
				</Badge>
			{/each}
		</div>
	{:else if typeof value === 'object'}
		<code class="block max-w-80 truncate text-xs text-muted-foreground">
			{JSON.stringify(value)}
		</code>
	{:else}
		<span class="block truncate">{String(value)}</span>
	{/if}
{/snippet}

<div class="flex min-h-0 flex-1 flex-col">
	{#if view.mode === 'unmodeled'}
		<header
			class="flex flex-wrap items-center justify-between gap-3 border-b bg-background/95 px-4 py-3"
		>
			<div>
				<h1 class="max-w-[70vw] truncate text-sm font-semibold">{folder}</h1>
				<div class="mt-1 flex flex-wrap gap-1.5">
					<Badge variant="secondary">{read.rows.length} rows</Badge>
					<Badge variant="secondary">{view.columns.length} columns</Badge>
					{#if read.unreadable.length}
						<Badge variant="destructive">{read.unreadable.length} unreadable</Badge>
					{/if}
				</div>
			</div>
			<Badge variant="outline">no model</Badge>
		</header>

		<Alert.Root class="rounded-none border-x-0 border-t-0 bg-muted/30" role="status">
			<FileWarningIcon />
			<Alert.Description class="text-xs">
				{#if view.modelError}
					Could not read matter.json ({view.modelError.message}). Showing the raw frontmatter; add a valid matter.json to classify files against a contract.
				{:else}
					No model for this folder. Showing the raw frontmatter; add a matter.json to classify files against a contract.
				{/if}
			</Alert.Description>
		</Alert.Root>

		<div class="flex-1 overflow-auto">
			<Table.Root class="min-w-full">
				<Table.Header>
					<Table.Row>
						{#each view.columns as key (key)}
							<Table.Head class="sticky top-0 z-10 bg-background">
								<span class="font-medium">{key}</span>
							</Table.Head>
						{/each}
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#if read.rows.length === 0}
						<Table.Row>
							<Table.Cell colspan={Math.max(1, view.columns.length)}>
								<Empty.Root class="min-h-64 border-0">
									<Empty.Header>
										<Empty.Title>No readable rows</Empty.Title>
										<Empty.Description>
											Add markdown files with frontmatter to see them here.
										</Empty.Description>
									</Empty.Header>
								</Empty.Root>
							</Table.Cell>
						</Table.Row>
					{:else}
						{#each read.rows as row (row.fileName)}
							<Table.Row>
								{#each view.columns as key (key)}
									<Table.Cell>{@render rawValue(row.frontmatter[key])}</Table.Cell>
								{/each}
							</Table.Row>
						{/each}
					{/if}
				</Table.Body>
			</Table.Root>
		</div>
	{:else}
		<header
			class="flex flex-wrap items-center justify-between gap-3 border-b bg-background/95 px-4 py-3"
		>
			<div>
				<h1 class="max-w-[70vw] truncate text-sm font-semibold">{folder}</h1>
				<div class="mt-1 flex flex-wrap gap-1.5">
					<Badge variant="secondary">
						{isFiltered
							? `${visibleRows.length} of ${read.rows.length} rows`
							: `${read.rows.length} rows`}
					</Badge>
					<Badge variant="secondary">{view.model.fields.length} fields</Badge>
					{#if read.unreadable.length}
						<Badge variant="destructive">{read.unreadable.length} unreadable</Badge>
					{/if}
				</div>
			</div>
			<ToggleGroup.Root
				type="single"
				variant="outline"
				size="sm"
				value={rowFilter}
				onValueChange={(value) => {
					if (value === 'all' || value === 'attention') rowFilter = value;
				}}
			>
				<ToggleGroup.Item value="all" aria-label="Show all rows">
					<ListIcon />
					All rows ({read.rows.length})
				</ToggleGroup.Item>
				<ToggleGroup.Item value="attention" aria-label="Show rows that need attention">
					<ListFilterIcon />
					Needs attention ({needsAttentionCount})
				</ToggleGroup.Item>
			</ToggleGroup.Root>
		</header>

		{#if view.model.unmodeled.length}
			<Alert.Root class="rounded-none border-x-0 border-t-0 bg-muted/30" role="status">
				<TriangleAlertIcon />
				<Alert.Description class="text-xs">
					{view.model.unmodeled.length}
					{view.model.unmodeled.length === 1 ? 'field has' : 'fields have'} an unrecognized
					shape ({view.model.unmodeled.join(', ')}). Values show raw in the row detail panel, not as typed columns.
				</Alert.Description>
			</Alert.Root>
		{/if}

		<div class="flex-1 overflow-auto">
			<Table.Root class="min-w-full table-fixed">
				<!-- table-fixed honours these <col> widths, so cells truncate instead of
				     stretching the column to the widest value. -->
				<colgroup>
					<col class="w-60" />
					{#each view.model.fields as field (field.name)}
						<col class={COLUMN_WIDTH[field.kind]} />
					{/each}
				</colgroup>
				<Table.Header>
					<Table.Row>
						<Table.Head class="sticky left-0 top-0 z-30 border-r bg-background align-bottom">
							<span class="text-xs font-medium text-muted-foreground">file</span>
						</Table.Head>
						{#each view.model.fields as field (field.name)}
							<Table.Head class="sticky top-0 z-20 bg-background align-bottom">
								<div
									class={['flex flex-col gap-0.5', columnAlign(field.kind).head]}
									title="{field.name} ({field.kind})"
								>
									<span class="max-w-full truncate font-medium leading-tight">
										{field.name}
									</span>
									<span
										class="text-[11px] font-normal uppercase leading-none tracking-wide text-muted-foreground/80"
									>
										{field.kind}
									</span>
								</div>
							</Table.Head>
						{/each}
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#if visibleRows.length === 0}
						<Table.Row>
							<Table.Cell colspan={view.model.fields.length + 1}>
								<Empty.Root class="min-h-64 border-0">
									<Empty.Header>
										<Empty.Title>{emptyState.title}</Empty.Title>
										<Empty.Description>{emptyState.description}</Empty.Description>
									</Empty.Header>
								</Empty.Root>
							</Table.Cell>
						</Table.Row>
					{:else}
						{#each visibleRows as conf (conf.row.fileName)}
							<Table.Row>
								<!-- Frozen identity cell: the file name is the row's id on disk, kept
								     visible while the typed columns scroll. !bg-background keeps it
								     opaque so scrolled cells never bleed through. -->
								<Table.Cell class="sticky left-0 z-10 border-r !bg-background">
									<div class="flex items-center gap-1.5">
										<Button
											variant="ghost"
											size="icon-xs"
											aria-label="Open row detail"
											tooltip={conf.extras.length
												? `Open row, ${conf.extras.length} extra keys`
												: 'Open row'}
											onclick={() => {
												detailFileName = conf.row.fileName;
												detailOpen = true;
											}}
										>
											<ExternalLinkIcon />
										</Button>
										<span
											class="truncate font-mono text-xs text-muted-foreground"
											title={conf.row.fileName}
										>
											{conf.row.fileName}
										</span>
									</div>
								</Table.Cell>
								{#each conf.cells as cell (cell.field.name)}
									<Table.Cell
										aria-invalid={cell.state === 'INVALID' || cell.state === 'NEEDS_VALUE'}
										class={[
											columnAlign(cell.field.kind).cell,
											cellStateClass(cell.state),
										]}
									>
										<ModeledCell
											{cell}
											mode="grid"
											save={(value) => onSaveField(conf.row.fileName, cell.field.name, value)}
											clear={() => onSaveField(conf.row.fileName, cell.field.name, undefined)}
										/>
									</Table.Cell>
								{/each}
							</Table.Row>
						{/each}
					{/if}
				</Table.Body>
			</Table.Root>
		</div>
	{/if}

	{#if read.unreadable.length}
		<section class="border-t bg-muted/20 px-4 py-3">
			<div class="flex items-center gap-2">
				<FileWarningIcon class="size-4 text-muted-foreground" />
				<h2 class="text-xs font-semibold text-muted-foreground">Can't read</h2>
			</div>
			<ul class="mt-1 space-y-0.5">
				{#each read.unreadable as file (file.fileName)}
					<li class="text-xs">
						<span class="font-mono">{file.fileName}</span>
						<span class="text-muted-foreground"> / {file.error.message}</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</div>

{#if detailConformance}
	<RowDetailDialog
		bind:open={detailOpen}
		conformance={detailConformance}
		{onSaveField}
		{onSaveBody}
	/>
{/if}
