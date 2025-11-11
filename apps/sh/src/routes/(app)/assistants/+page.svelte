<script lang="ts">
	import { page } from '$app/state';
	import AssistantTableRow from '$lib/components/AssistantTableRow.svelte';
	import CreateAssistantConfigModal from '$lib/components/CreateAssistantConfigModal.svelte';
	import { assistantConfigs } from '$lib/stores/assistant-configs.svelte';
	import { useCreateAssistantParams } from '$lib/utils/search-params.svelte';
	import { safeLookup } from '@repo/shared';
	import { Button, buttonVariants } from '@repo/ui/button';
	import * as DropdownMenu from '@repo/ui/dropdown-menu';
	import * as Table from '@repo/ui/table';
	import { cn } from '@repo/ui/utils';
	import { ChevronDown, Plus } from '@lucide/svelte';

	// Define available columns
	const columns = [
		{ hideable: false, id: 'name', label: 'Name' },
		{ hideable: true, id: 'url', label: 'URL' },
		{ hideable: true, id: 'rootPath', label: 'Root Path' },
		{ hideable: true, id: 'cwd', label: 'CWD' },
		{ hideable: false, id: 'status', label: 'Status' },
		{ hideable: true, id: 'lastUsed', label: 'Last Used' },
		{ hideable: false, id: 'actions', label: 'Actions' },
	] as const;

	type ColumnId = (typeof columns)[number]['id'];

	// Persisted column visibility state
	let columnVisibility = $state<Record<ColumnId, boolean>>({
		actions: true,
		cwd: false, // Hidden by default
		lastUsed: true,
		name: true,
		rootPath: false, // Hidden by default
		status: true,
		url: true,
	});

	useCreateAssistantParams(page.url);

	// Get assistant configs from local storage
	const configs = $derived(assistantConfigs.value);
</script>

<svelte:head>
	<title>Assistants - Manage Your OpenCode Connections | epicenter.sh</title>
	<meta
		name="description"
		content="Connect to OpenCode servers running locally or tunneled through ngrok. Manage multiple AI assistants for different codebases."
	/>
</svelte:head>

<div class="px-4 sm:px-6 py-6 sm:py-8">
	<div
		class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6"
	>
		<div>
			<h1 class="text-3xl font-bold tracking-tight">Assistants</h1>
			<p class="text-muted-foreground mt-1">
				Manage your OpenCode server connections
			</p>
		</div>
		<div class="flex items-center gap-2">
			<DropdownMenu.Root>
				<DropdownMenu.Trigger
					class={cn(
						buttonVariants({ variant: 'outline' }),
						'items-center transition-all [&[data-state=open]>svg]:rotate-180',
					)}
				>
					Columns <ChevronDown
						class="ml-2 h-4 w-4 transition-transform duration-200"
					/>
				</DropdownMenu.Trigger>
				<DropdownMenu.Content>
					{#each columns.filter((c) => c.hideable) as column}
						<DropdownMenu.CheckboxItem
							bind:checked={
								() => safeLookup(columnVisibility, column.id) ?? true,
								(checked) => {
									columnVisibility = {
										...columnVisibility,
										[column.id]: checked,
									};
								}
							}
						>
							{column.label}
						</DropdownMenu.CheckboxItem>
					{/each}
				</DropdownMenu.Content>
			</DropdownMenu.Root>

			<CreateAssistantConfigModal>
				{#snippet triggerChild({ props })}
					<Button {...props}><Plus class="mr-2 h-4 w-4" /> Add Assistant</Button
					>
				{/snippet}
			</CreateAssistantConfigModal>
		</div>
	</div>

	{#if configs.length === 0}
		<div class="rounded-lg border border-dashed p-8 text-center">
			<h3 class="text-lg font-semibold">No assistants yet</h3>
			<p class="text-muted-foreground mt-2">
				Create your first assistant to connect to an OpenCode server
			</p>
			<CreateAssistantConfigModal>
				{#snippet triggerChild({ props })}
					<Button {...props} class="mt-4">Create Assistant</Button>
				{/snippet}
			</CreateAssistantConfigModal>
		</div>
	{:else}
		<div class="rounded border">
			<Table.Root>
				<Table.Header>
					<Table.Row>
						{#if columnVisibility.name !== false}<Table.Head>Name</Table.Head
							>{/if}
						{#if columnVisibility.url !== false}<Table.Head>URL</Table.Head
							>{/if}
						{#if columnVisibility.rootPath !== false}<Table.Head
								>Root Path</Table.Head
							>{/if}
						{#if columnVisibility.cwd !== false}<Table.Head>CWD</Table.Head
							>{/if}
						{#if columnVisibility.status !== false}<Table.Head
								>Status</Table.Head
							>{/if}
						{#if columnVisibility.lastUsed !== false}<Table.Head
								>Last Used</Table.Head
							>{/if}
						{#if columnVisibility.actions !== false}<Table.Head
								class="text-right">Actions</Table.Head
							>{/if}
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each configs as config}
						<AssistantTableRow {config} {columnVisibility} />
					{/each}
				</Table.Body>
			</Table.Root>
		</div>
	{/if}
</div>
