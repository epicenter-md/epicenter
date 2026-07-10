<script lang="ts">
	import { Input } from '@epicenter/ui/input';
	import * as Table from '@epicenter/ui/table';
	import Search from '@lucide/svelte/icons/search';
	import type { Snippet } from 'svelte';
	import { type Command, commands } from '$lib/commands';

	// Platform-agnostic chrome: a searchable table of every command. The caller
	// owns what a row's shortcut control is (the reach-routed keyboard recorder)
	// and supplies it through the `row` snippet, so this component holds no
	// local/global discriminator.
	let { row }: { row: Snippet<[Command]> } = $props();

	let searchQuery = $state('');

	const filteredCommands = $derived(
		commands.filter((command) =>
			command.title.toLowerCase().includes(searchQuery.toLowerCase()),
		),
	);
</script>

<div class="space-y-4">
	<!-- Search input -->
	<div class="relative">
		<Search
			class="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
		/>
		<Input
			type="search"
			placeholder="Search commands..."
			class="pl-10"
			bind:value={searchQuery}
		/>
	</div>

	<!-- Command list with shortcuts -->
	<div class="overflow-x-auto rounded-lg border">
		<Table.Root>
			<Table.Header>
				<Table.Row>
					<Table.Head class="min-w-[150px]">Command</Table.Head>
					<Table.Head class="text-right min-w-[200px]">Shortcut</Table.Head>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{#each filteredCommands as command}
					<Table.Row>
						<Table.Cell class="font-medium">
							<span class="block truncate pr-2">{command.title}</span>
						</Table.Cell>
						<Table.Cell class="text-right">
							{@render row(command)}
						</Table.Cell>
					</Table.Row>
				{/each}
			</Table.Body>
		</Table.Root>
	</div>
</div>
