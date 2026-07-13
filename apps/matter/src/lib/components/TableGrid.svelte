<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import * as InputGroup from '@epicenter/ui/input-group';
	import * as Table from '@epicenter/ui/table';
	import * as ToggleGroup from '@epicenter/ui/toggle-group';
	import ArrowDownIcon from '@lucide/svelte/icons/arrow-down';
	import ArrowUpIcon from '@lucide/svelte/icons/arrow-up';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import FileWarningIcon from '@lucide/svelte/icons/file-warning';
	import ListIcon from '@lucide/svelte/icons/list';
	import ListFilterIcon from '@lucide/svelte/icons/list-filter';
	import SearchIcon from '@lucide/svelte/icons/search';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import type { Kind } from '@epicenter/field';
	import {
		type Cell,
		type ReferenceVerdict,
		stemOf,
		type TableAssessment,
	} from '@epicenter/matter-core';
	import type { TableView } from '$lib/table.svelte';
	import type { TableQuery } from '$lib/table-query.svelte';
	import ModeledCell from './ModeledCell.svelte';
	import ReferenceVerdictIndicator from './ReferenceVerdict.svelte';
	import RowDetailDialog from './RowDetailDialog.svelte';

	// The grid renders from a {@link TableView} (the slice of a live table the grid is allowed to
	// touch), injected by the active TablePane. The narrow getters are bound once here so the
	// template reads `read` / `folder` / `onSave*` directly, and a table swap (switch tables in the
	// vault) flows through these derivations.
	// `query` is the pane's unified query (WHERE filter, full-text match, column sort). The grid renders
	// its controls in the header and orders rows by what the query matched; `undefined`, or no active
	// control, means render every row in its natural order.
	// `assessment` is THIS table's place in the vault's integrity: it carries the cross-table
	// reference verdicts (resolved / dangling / missing-target) the conformance `Cell` cannot
	// know on its own. Optional, so a table rendered outside a vault simply shows no chips.
	let {
		table,
		query,
		assessment,
	}: {
		table: TableView;
		query?: TableQuery;
		assessment?: TableAssessment;
	} = $props();

	// fileName -> field name -> the reference verdict for that cell, built once per assessment.
	// Only present, valid pointers land here (the three reference-only states); a missing or
	// invalid reference value has no verdict and renders through the ordinary editor.
	const referenceVerdicts = $derived.by(() => {
		const byFile = new Map<string, Map<string, ReferenceVerdict>>();
		if (assessment?.status !== 'typed') return byFile;
		for (const { row, cells } of assessment.rows) {
			const byField = new Map<string, ReferenceVerdict>();
			for (const cell of cells) {
				if (
					cell.state === 'resolved' ||
					cell.state === 'dangling' ||
					cell.state === 'missing-target'
				) {
					byField.set(cell.field.name, cell);
				}
			}
			if (byField.size > 0) byFile.set(row.fileName, byField);
		}
		return byFile;
	});

	// The stems the query matched, in SQL order, or undefined when no control is active (then the grid
	// renders the in-memory rows in their natural order). `isQuerying` is whether any control is set.
	const orderedStems = $derived(query?.orderedStems);
	const isQuerying = $derived(query?.isActive ?? false);

	const read = $derived(table.read);
	const onSaveField = $derived(table.saveField);
	const onSaveBody = $derived(table.saveBody);
	const view = $derived(read.view);

	type RowFilter = 'all' | 'attention' | 'ready';

	// The row filter is a view mode over the same table, not a relayout.
	let rowFilter = $state<RowFilter>('all');

	const filteredRows = $derived.by(() => {
		if (view.mode !== 'typed') return [];
		// No active query control: render the in-memory rows in their natural (insertion) order. The
		// local alias is load-bearing: it narrows `string[] | undefined` to `string[]` in the closure.
		const ordered = orderedStems;
		if (!ordered) return view.conformance;
		// SQL decided which rows and in what order; render in that order via a stem -> row map, skipping
		// any stem the in-memory rows do not have yet (the mirror can briefly run ahead of memory after
		// an edit). This preserves SQL order, where intersecting against insertion order would not.
		const byStem = new Map(
			view.conformance.map((c) => [stemOf(c.row.fileName), c]),
		);
		return ordered.flatMap((stem) => {
			const conf = byStem.get(stem);
			return conf ? [conf] : [];
		});
	});

	const visibleRows = $derived.by(() => {
		if (rowFilter === 'attention') return filteredRows.filter((c) => !c.rowValid);
		if (rowFilter === 'ready') return filteredRows.filter((c) => c.rowValid);
		return filteredRows;
	});

	// "X of Y rows" whenever a lens is narrowing the table (attention OR an active query control).
	const isFiltered = $derived(rowFilter !== 'all' || isQuerying);

	// The typed empty-state copy as ONE mutually exclusive decision, so the title and the
	// description always describe the same case. Reads top-down like the question a person
	// asks ("is a filter on? is attention on? otherwise it is just empty") instead of two
	// nested ternaries in the markup that have to be kept in sync by hand.
	const emptyState = $derived.by(() => {
		if (isQuerying && filteredRows.length === 0)
			return {
				title: 'No rows match',
				description: 'No rows match the current filter, search, or sort.',
			};
		if (rowFilter === 'attention')
			return {
				title: isQuerying ? 'No matching rows need attention' : 'No rows need attention',
				description: isQuerying
					? 'The rows the query matched are all valid.'
					: 'Every readable row matches this contract.',
			};
		if (rowFilter === 'ready')
			return {
				title: isQuerying ? 'No matching ready rows' : 'No ready rows',
				description: isQuerying
					? 'The rows the query matched all need attention.'
					: 'Fix required or invalid fields to make rows ready.',
			};
		return {
			title: 'No rows yet',
			description: 'Add markdown files with frontmatter to see them here.',
		};
	});

	const needsAttentionCount = $derived(filteredRows.filter((c) => !c.rowValid).length);
	const readyRowsCount = $derived(filteredRows.filter((c) => c.rowValid).length);

	let detailOpen = $state(false);
	let detailFileName = $state<string>();
	const detailConformance = $derived.by(() => {
		if (view.mode !== 'typed' || !detailFileName) return undefined;
		return view.conformance.find((conf) => conf.row.fileName === detailFileName);
	});

	// Per-kind column width: the `<col>` basis under `table-fixed`, so the grid reads
	// like a spreadsheet (a number column a third the width of a tags column) instead
	// of equal slabs. Keyed on `field.kind`, the stable discriminant, so sizing is
	// semantic, not positional: no "the first column is the title" guess. `satisfies
	// Record<Kind, string>` makes a new palette kind fail to compile until it has a
	// width here, the same exhaustiveness gate the widget registry carries.
	const COLUMN_WIDTH = {
		string: 'w-56',
		reference: 'w-56',
		url: 'w-56',
		date: 'w-32',
		instant: 'w-44',
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
		if (state === 'MISSING_REQUIRED') {
			return 'bg-amber-500/5 ring-1 ring-inset ring-amber-500/30';
		}

		if (state === 'INVALID') {
			return 'bg-destructive/5 ring-1 ring-inset ring-destructive/30';
		}

		return '';
	}

	function setRowFilter(value: string | undefined): void {
		if (value === 'all' || value === 'attention' || value === 'ready') {
			rowFilter = value;
		}
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

<!-- Raw value render for the untyped view: plain text, no type guessing. -->
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

<!-- The editable cell widget, shared by the plain path and the reference-adorned path so the two
     never drift. The reference path wraps this with a verdict indicator; everything else renders
     it bare. -->
{#snippet cellEditor(cell: Cell, fileName: string)}
	<ModeledCell
		{cell}
		mode="grid"
		save={(value) => onSaveField(fileName, cell.field.name, value)}
		clear={() => onSaveField(fileName, cell.field.name, undefined)}
	/>
{/snippet}

{#snippet rowFilterItem(
	value: RowFilter,
	label: string,
	count: number,
	Icon: typeof ListIcon,
	ariaLabel: string,
)}
	<ToggleGroup.Item {value} aria-label={ariaLabel} class="flex-none gap-1.5">
		<Icon data-icon="inline-start" class="size-4" />
		<span>{label}</span>
		<span class="tabular-nums text-muted-foreground">{count}</span>
	</ToggleGroup.Item>
{/snippet}

<!-- The sort affordance on a column header: the active direction when this column is the sort key, or
     a faint hint that the column is sortable. Rendered only inside a vault (when `query` is present). -->
{#snippet sortIndicator(column: string)}
	{#if query?.sort?.column === column}
		{#if query.sort.dir === 'asc'}
			<ArrowUpIcon class="size-3.5 shrink-0" />
		{:else}
			<ArrowDownIcon class="size-3.5 shrink-0" />
		{/if}
	{:else}
		<ChevronsUpDownIcon class="size-3.5 shrink-0 text-muted-foreground/40" />
	{/if}
{/snippet}

<div class="flex min-h-0 flex-1 flex-col">
	{#if view.mode === 'untyped'}
		<header class="flex items-center gap-2 border-b px-3 py-2">
			<Badge variant="secondary">{read.rows.length} rows</Badge>
			<Badge variant="secondary">{view.columns.length} columns</Badge>
			<Badge variant="outline">no contract</Badge>
		</header>

		<Alert.Root class="rounded-none border-x-0 border-t-0 bg-muted/30" role="status">
			<FileWarningIcon />
			<Alert.Description class="text-xs">
				{#if view.contractError}
					Could not read matter.json ({view.contractError.message}). Showing the raw frontmatter; add a valid matter.json to classify files against a contract.
				{:else}
					No contract for this folder. Showing the raw frontmatter; add a matter.json to classify files against a contract.
				{/if}
			</Alert.Description>
		</Alert.Root>

		<!-- Table.Root includes a horizontal scroll wrapper. This grid pane owns both
		     axes so sticky headers and the frozen file column use the same scrollport. -->
		<div class="flex-1 overflow-auto [&>[data-slot=table-container]]:overflow-visible">
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
		<header class="flex flex-wrap items-center gap-2 border-b px-3 py-2">
			<Badge variant="secondary" class="shrink-0">
				{isFiltered
					? `${visibleRows.length} of ${read.rows.length} rows`
					: `${read.rows.length} rows`}
			</Badge>
			<div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
				{#if query}
					<!-- Search only exists for a searchable folder: an empty `searchable` projects no FTS
					     table, so a MATCH would hit "no such table". -->
					{#if view.contract.searchable.length}
						<InputGroup.Root class="w-40">
							<InputGroup.Addon><SearchIcon /></InputGroup.Addon>
							<InputGroup.Input
								bind:value={query.match}
								name="search"
								placeholder="Search rows"
								spellcheck={false}
								autocomplete="off"
								aria-label="Full-text search row bodies and text fields"
							/>
						</InputGroup.Root>
					{/if}
					<InputGroup.Root class="w-52">
						<InputGroup.Addon>
							<span class="font-mono text-xs text-muted-foreground">WHERE</span>
						</InputGroup.Addon>
						<InputGroup.Input
							bind:value={query.where}
							name="where"
							placeholder="status = 'ready'"
							spellcheck={false}
							autocapitalize="off"
							autocomplete="off"
							autocorrect="off"
							aria-invalid={Boolean(query.error)}
							aria-label="Filter rows with a SQL WHERE clause"
							title={query.error}
							class="font-mono"
						/>
					</InputGroup.Root>
				{/if}
				<ToggleGroup.Root
					type="single"
					variant="outline"
					size="sm"
					spacing={1}
					class="ml-auto max-w-full flex-wrap justify-end"
					bind:value={() => rowFilter, setRowFilter}
				>
					{@render rowFilterItem(
						'all',
						'All',
						filteredRows.length,
						ListIcon,
						'Show all rows',
					)}
					{@render rowFilterItem(
						'attention',
						'Attention',
						needsAttentionCount,
						ListFilterIcon,
						'Show rows that need attention',
					)}
					{@render rowFilterItem('ready', 'Ready', readyRowsCount, CheckIcon, 'Show ready rows')}
				</ToggleGroup.Root>
			</div>
		</header>

		{#if view.contract.untyped.length}
			<Alert.Root class="rounded-none border-x-0 border-t-0 bg-muted/30" role="status">
				<TriangleAlertIcon />
				<Alert.Description class="text-xs">
					{view.contract.untyped.length}
					{view.contract.untyped.length === 1 ? 'field has' : 'fields have'} an unrecognized
					shape ({view.contract.untyped.join(', ')}). Values show raw in the row detail panel, not as typed columns.
				</Alert.Description>
			</Alert.Root>
		{/if}

		{#if view.contract.unmatchedOptional.length}
			<Alert.Root class="rounded-none border-x-0 border-t-0 bg-muted/30" role="status">
				<TriangleAlertIcon />
				<Alert.Description class="text-xs">
					Optional entries do not match typed fields ({view.contract.unmatchedOptional.join(', ')}).
				</Alert.Description>
			</Alert.Root>
		{/if}

		<!-- Table.Root includes a horizontal scroll wrapper. This grid pane owns both
		     axes so sticky headers and the frozen file column use the same scrollport. -->
		<div class="flex-1 overflow-auto [&>[data-slot=table-container]]:overflow-visible">
			<Table.Root class="min-w-full table-fixed">
				<!-- table-fixed honours these <col> widths, so cells truncate instead of
				     stretching the column to the widest value. -->
				<colgroup>
					<col class="w-60" />
					{#each view.contract.fields as field (field.name)}
						<col class={COLUMN_WIDTH[field.kind]} />
					{/each}
				</colgroup>
				<Table.Header>
					<Table.Row>
						<Table.Head class="sticky left-0 top-0 z-30 border-r bg-background align-bottom">
							{#if query}
								<button
									type="button"
									onclick={() => query.toggleSort('stem')}
									title="Sort by file name"
									class="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
								>
									file
									{@render sortIndicator('stem')}
								</button>
							{:else}
								<span class="text-xs font-medium text-muted-foreground">file</span>
							{/if}
						</Table.Head>
						{#each view.contract.fields as field (field.name)}
							<Table.Head class="sticky top-0 z-20 bg-background align-bottom">
								{#if query}
									<button
										type="button"
										onclick={() => query.toggleSort(field.name)}
										title="{field.name} ({field.kind}): click to sort"
										class={[
											'flex w-full flex-col gap-0.5 hover:text-foreground',
											columnAlign(field.kind).head,
										]}
									>
										<span class="flex max-w-full items-center gap-1">
											<span class="truncate font-medium leading-tight">{field.name}</span>
											{@render sortIndicator(field.name)}
										</span>
										<span
											class="text-[11px] font-normal uppercase leading-none tracking-wide text-muted-foreground/80"
										>
											{field.kind}
										</span>
									</button>
								{:else}
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
								{/if}
							</Table.Head>
						{/each}
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#if visibleRows.length === 0}
						<Table.Row>
							<Table.Cell colspan={view.contract.fields.length + 1}>
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
									{@const verdict = referenceVerdicts.get(conf.row.fileName)?.get(cell.field.name)}
									<Table.Cell
										aria-invalid={cell.state === 'INVALID' || cell.state === 'MISSING_REQUIRED'}
										class={[
											columnAlign(cell.field.kind).cell,
											cellStateClass(cell.state),
										]}
									>
										{#if verdict}
											<div class="flex items-center gap-1.5">
												<ReferenceVerdictIndicator {verdict} />
												<div class="min-w-0 flex-1">
													{@render cellEditor(cell, conf.row.fileName)}
												</div>
											</div>
										{:else}
											{@render cellEditor(cell, conf.row.fileName)}
										{/if}
									</Table.Cell>
								{/each}
							</Table.Row>
						{/each}
					{/if}
				</Table.Body>
			</Table.Root>
		</div>
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
