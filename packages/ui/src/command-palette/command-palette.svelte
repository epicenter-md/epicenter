<script lang="ts">
	import * as Command from '#command/index.js';
	import { confirmationDialog } from '#confirmation-dialog/index.js';
	import type { CommandPaletteItem } from './index.js';

	let {
		items,
		open = $bindable(false),
		value = $bindable(''),
		placeholder = 'Search commands...',
		emptyMessage = 'No commands found.',
		title = 'Command Palette',
		description = 'Search for a command to run',
		shouldFilter,
	}: {
		items: CommandPaletteItem[];
		open: boolean;
		/** Bindable search input value. Use with `shouldFilter={false}` for custom filtering. */
		value?: string;
		placeholder?: string;
		emptyMessage?: string;
		title?: string;
		description?: string;
		/** Set `false` to manage filtering yourself (e.g. debounced async search). */
		shouldFilter?: boolean;
	} = $props();

	// ── Group items by the `group` field ────────────────────────────
	const grouped = $derived(Map.groupBy(items, (item) => item.group));

</script>

<Command.Dialog bind:open {title} {description} {shouldFilter}>
	<Command.Input {placeholder} bind:value />
	<Command.List>
		<Command.Empty>{emptyMessage}</Command.Empty>
		{#each grouped as [ group, groupItems ]}
			<Command.Group heading={group}>
				{#each groupItems as item (item.id)}
					<Command.Item
						value={item.label}
						keywords={item.keywords}
						onSelect={() => {
							open = false;
							if (item.destructive) {
								confirmationDialog.open({
									title: item.label,
									description: item.description ?? 'Are you sure?',
									confirm: { text: 'Confirm', variant: 'destructive' },
									onConfirm: () => item.onSelect(),
								});
							} else {
								item.onSelect();
							}
						}}
					>
						{#if item.icon}
							{@const Icon = item.icon}
							<Icon class="size-4" />
						{/if}
						<div class="flex flex-col">
							<span>{item.label}</span>
							{#if item.description}
								<span class="text-xs text-muted-foreground">
									{item.description}
								</span>
							{/if}
						</div>
					</Command.Item>
				{/each}
			</Command.Group>
		{/each}
	</Command.List>
</Command.Dialog>
