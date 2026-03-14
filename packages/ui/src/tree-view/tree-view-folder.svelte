<script lang="ts">
	import FolderIcon from '@lucide/svelte/icons/folder';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import * as Collapsible from '../collapsible/index.js';
	import { cn } from '../utils.js';
	import type { TreeViewFolderProps } from './types';

	let {
		name,
		open = $bindable(true),
		onOpenChange,
		class: className,
		icon,
		children,
	}: TreeViewFolderProps = $props();
</script>

<Collapsible.Root bind:open {onOpenChange}>
	<Collapsible.Trigger class={cn('flex place-items-center gap-1', className)}>
		{#if icon}
			{@render icon({ name, open })}
		{:else if open}
			<FolderOpenIcon class="size-4" />
		{:else}
			<FolderIcon class="size-4" />
		{/if}
		<span>{name}</span>
	</Collapsible.Trigger>
	<Collapsible.Content class="ml-2 border-l">
		<div class="relative flex place-items-start">
			<div class="bg-border mx-2 h-full w-px"></div>
			<div class="flex flex-1 flex-col gap-0.5">{@render children?.()}</div>
		</div>
	</Collapsible.Content>
</Collapsible.Root>
