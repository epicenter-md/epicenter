<script lang="ts">
	import * as Empty from '@epicenter/ui/empty';
	import { Badge } from '@epicenter/ui/badge';
	import TableIcon from '@lucide/svelte/icons/table-2';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import {
		GenericTableViewer,
		GenericKvViewer,
	} from '$lib/workspaces/static/components';

	let { data } = $props();
</script>

<div class="space-y-6">
	<!-- Header -->
	<div class="flex items-center gap-3">
		<div class="bg-muted flex size-10 items-center justify-center rounded-lg">
			<DatabaseIcon class="size-5" />
		</div>
		<div>
			<h1 class="text-xl font-semibold">{data.displayName}</h1>
			<p class="text-muted-foreground font-mono text-sm">{data.workspaceId}</p>
		</div>
	</div>

	<!-- Summary -->
	<div class="flex gap-4">
		<Badge variant="secondary" class="gap-1.5">
			<TableIcon class="size-3" />
			{data.tables.length} tables
		</Badge>
		<Badge variant="secondary" class="gap-1.5">
			<SettingsIcon class="size-3" />
			{data.kvKeys.length} settings
		</Badge>
	</div>

	<!-- Content -->
	{#if data.tables.length === 0 && data.kvKeys.length === 0}
		<Empty.Root>
			<Empty.Header>
				<Empty.Media variant="icon">
					<DatabaseIcon />
				</Empty.Media>
				<Empty.Title>No data yet</Empty.Title>
				<Empty.Description>
					This workspace is empty or hasn't synced any data yet.
				</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else}
		<!-- Tables -->
		{#if data.tables.length > 0}
			<section class="space-y-3">
				<h2 class="text-muted-foreground text-sm font-medium">Tables</h2>
				{#each data.tables as tableName (tableName)}
					<GenericTableViewer
						ydoc={data.connection.ydoc}
						{tableName}
						initialRows={data.tableData[tableName] ?? []}
					/>
				{/each}
			</section>
		{/if}

		<!-- KV -->
		{#if data.kvKeys.length > 0}
			<section class="space-y-3">
				<h2 class="text-muted-foreground text-sm font-medium">Settings</h2>
				<GenericKvViewer
					ydoc={data.connection.ydoc}
					keys={data.kvKeys}
					initialValues={data.kvData}
				/>
			</section>
		{/if}
	{/if}
</div>
