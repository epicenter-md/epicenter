<script lang="ts">
	import { page } from '$app/state';
	import * as Tabs from '@epicenter/ui/tabs';
	import * as Table from '@epicenter/ui/table';
	import * as Empty from '@epicenter/ui/empty';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import { Button } from '@epicenter/ui/button';
	import { Badge } from '@epicenter/ui/badge';
	import { isNullableField, type Field } from '@epicenter/hq/dynamic';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import TrashIcon from '@lucide/svelte/icons/trash-2';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import TableIcon from '@lucide/svelte/icons/table-2';
	import CodeIcon from '@lucide/svelte/icons/code';
	import SearchXIcon from '@lucide/svelte/icons/search-x';

	let { data } = $props();

	const tableId = $derived(page.params.tableId);

	// Definition comes from the layout loader
	const definition = $derived(data.definition);

	const tableEntry = $derived.by(() => {
		if (!tableId || !definition?.tables) return undefined;
		// tables is an array now - find by id
		return definition.tables.find((t) => t.id === tableId);
	});

	const tableFields = $derived(tableEntry?.fields);
	const tableName = $derived(tableEntry?.name ?? tableId);

	// Fields is now an array - map to [id, field] pairs for backwards compat with template
	const columns = $derived(
		tableFields ? (tableFields.map((f) => [f.id, f]) as [string, Field][]) : [],
	);

	// Get actual table data from the YJS-backed client
	const tableHelper = $derived(
		tableId && data.client?.tables
			? data.client.tables.get(tableId)
			: undefined,
	);

	const rows = $derived.by(() => {
		if (!tableHelper) return [];
		return tableHelper.getAllValid();
	});

	let activeTab = $state('data');
</script>

<div class="space-y-4">
	{#if !tableFields}
		<Empty.Root>
			<Empty.Header>
				<Empty.Media variant="icon">
					<SearchXIcon />
				</Empty.Media>
				<Empty.Title>Table not found</Empty.Title>
				<Empty.Description>
					The table "{tableId}" does not exist in this workspace.
				</Empty.Description>
			</Empty.Header>
			<Empty.Content>
				<Button variant="outline" href="/workspaces/{data.definition.id}">
					Back to workspace
				</Button>
			</Empty.Content>
		</Empty.Root>
	{:else}
		<!-- Header -->
		<div class="flex items-center justify-between">
			<div>
				<h1 class="text-2xl font-semibold">{tableName}</h1>
				<p class="text-muted-foreground text-sm">
					{columns.length} column{columns.length === 1 ? '' : 's'} · {rows.length}
					row{rows.length === 1 ? '' : 's'}
				</p>
			</div>
			<Button disabled>
				<PlusIcon class="mr-2 size-4" />
				Add Row
			</Button>
		</div>

		<!-- Tabs -->
		<Tabs.Root bind:value={activeTab}>
			<Tabs.List>
				<Tabs.Trigger value="data">
					<DatabaseIcon class="mr-2 size-4" />
					Data
				</Tabs.Trigger>
				<Tabs.Trigger value="schema">
					<TableIcon class="mr-2 size-4" />
					Schema
				</Tabs.Trigger>
				<Tabs.Trigger value="raw">
					<CodeIcon class="mr-2 size-4" />
					Raw
				</Tabs.Trigger>
			</Tabs.List>

			<!-- Data Tab -->
			<Tabs.Content value="data">
				{#if rows.length === 0}
					<Empty.Root class="mt-4">
						<Empty.Header>
							<Empty.Media variant="icon">
								<DatabaseIcon />
							</Empty.Media>
							<Empty.Title>No data yet</Empty.Title>
							<Empty.Description>
								Add rows to this table to see them here.
							</Empty.Description>
						</Empty.Header>
						<Empty.Content>
							<Button disabled>
								<PlusIcon class="mr-2 size-4" />
								Add Row
							</Button>
						</Empty.Content>
					</Empty.Root>
				{:else}
					<div class="mt-4 rounded-md border">
						<Table.Root>
							<Table.Header>
								<Table.Row>
									{#each columns as [columnName] (columnName)}
										<Table.Head>{columnName}</Table.Head>
									{/each}
									<Table.Head class="w-12"></Table.Head>
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#each rows as row (row.id)}
									<Table.Row>
										{#each columns as [columnName] (columnName)}
											<Table.Cell class="font-mono text-sm">
												{@const value = row[columnName]}
												{#if value === null || value === undefined}
													<span class="text-muted-foreground">-</span>
												{:else if typeof value === 'object'}
													<code class="bg-muted rounded px-1.5 py-0.5 text-xs">
														{JSON.stringify(value)}
													</code>
												{:else}
													{value}
												{/if}
											</Table.Cell>
										{/each}
										<Table.Cell>
											<DropdownMenu.Root>
												<DropdownMenu.Trigger>
													{#snippet child({ props }: { props: any })}
														<Button
															{...props}
															variant="ghost"
															size="icon"
															class="size-8"
														>
															<EllipsisIcon class="size-4" />
															<span class="sr-only">Open menu</span>
														</Button>
													{/snippet}
												</DropdownMenu.Trigger>
												<DropdownMenu.Content align="end">
													<DropdownMenu.Item disabled>Edit</DropdownMenu.Item>
													<DropdownMenu.Separator />
													<DropdownMenu.Item class="text-destructive" disabled>
														<TrashIcon class="mr-2 size-4" />
														Delete
													</DropdownMenu.Item>
												</DropdownMenu.Content>
											</DropdownMenu.Root>
										</Table.Cell>
									</Table.Row>
								{/each}
							</Table.Body>
						</Table.Root>
					</div>
				{/if}
			</Tabs.Content>

			<!-- Schema Tab -->
			<Tabs.Content value="schema">
				<div class="mt-4 rounded-md border">
					<Table.Root>
						<Table.Header>
							<Table.Row>
								<Table.Head>Column Name</Table.Head>
								<Table.Head>Type</Table.Head>
								<Table.Head>Nullable</Table.Head>
								<Table.Head>Default</Table.Head>
								<Table.Head class="w-12"></Table.Head>
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each columns as [columnName, schema] (columnName)}
								{@const isNullable = isNullableField(schema)}
								{@const hasDefault = 'default' in schema}
								<Table.Row>
									<Table.Cell class="font-mono text-sm">{columnName}</Table.Cell
									>
									<Table.Cell>
										<Badge variant="secondary">{schema.type}</Badge>
									</Table.Cell>
									<Table.Cell>
										{#if isNullable}
											<Badge variant="outline">nullable</Badge>
										{:else}
											<span class="text-muted-foreground text-sm">required</span
											>
										{/if}
									</Table.Cell>
									<Table.Cell>
										{#if hasDefault}
											<code class="bg-muted rounded px-1.5 py-0.5 text-xs">
												{JSON.stringify(schema.default)}
											</code>
										{:else}
											<span class="text-muted-foreground text-sm">-</span>
										{/if}
									</Table.Cell>
									<Table.Cell>
										{#if columnName !== 'id'}
											<DropdownMenu.Root>
												<DropdownMenu.Trigger>
													{#snippet child({ props }: { props: any })}
														<Button
															{...props}
															variant="ghost"
															size="icon"
															class="size-8"
														>
															<EllipsisIcon class="size-4" />
															<span class="sr-only">Open menu</span>
														</Button>
													{/snippet}
												</DropdownMenu.Trigger>
												<DropdownMenu.Content align="end">
													<DropdownMenu.Item disabled>Edit</DropdownMenu.Item>
													<DropdownMenu.Separator />
													<DropdownMenu.Item class="text-destructive" disabled>
														<TrashIcon class="mr-2 size-4" />
														Delete
													</DropdownMenu.Item>
												</DropdownMenu.Content>
											</DropdownMenu.Root>
										{/if}
									</Table.Cell>
								</Table.Row>
							{:else}
								<Table.Row>
									<Table.Cell colspan={5} class="h-24 text-center">
										<Empty.Root>
											<Empty.Title>No columns</Empty.Title>
											<Empty.Description>
												This table has no columns defined yet.
											</Empty.Description>
										</Empty.Root>
									</Table.Cell>
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</div>
			</Tabs.Content>

			<!-- Raw Tab -->
			<Tabs.Content value="raw">
				<div class="mt-4 rounded-lg border p-4">
					<h2 class="mb-2 font-medium">Raw Schema</h2>
					<pre
						class="bg-muted overflow-auto rounded p-4 text-xs">{JSON.stringify(
							tableEntry,
							null,
							2,
						)}</pre>
				</div>
			</Tabs.Content>
		</Tabs.Root>
	{/if}
</div>
