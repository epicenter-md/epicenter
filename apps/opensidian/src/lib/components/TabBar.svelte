<script lang="ts">
	import type { FileId } from '@epicenter/filesystem';
	import * as Tabs from '@epicenter/ui/tabs';
	import XIcon from '@lucide/svelte/icons/x';
	import { fsState } from '$lib/fs/fs-state.svelte';

	const hasOpenFiles = $derived(fsState.openFileIds.length > 0);

	function handleValueChange(value: string) {
		fsState.actions.selectFile(value as FileId);
	}

	/**
	 * Close a tab, stopping propagation so the tab doesn't also get selected.
	 */
	function handleClose(e: MouseEvent, id: FileId) {
		e.stopPropagation();
		e.preventDefault();
		fsState.actions.closeFile(id);
	}

	/**
	 * Middle-click to close a tab.
	 */
	function handleAuxClick(e: MouseEvent, id: FileId) {
		if (e.button === 1) {
			e.preventDefault();
			fsState.actions.closeFile(id);
		}
	}
</script>

{#if hasOpenFiles}
	<Tabs.Root
		value={fsState.activeFileId ?? ''}
		onValueChange={handleValueChange}
		class="w-full"
	>
		<Tabs.List
			class="w-full justify-start overflow-x-auto rounded-none border-b bg-transparent p-0"
		>
			{#each fsState.openFileIds as fileId (fileId)}
				{@const row = fsState.getRow(fileId)}
				{#if row}
					<Tabs.Trigger
						value={fileId}
						class="relative flex-none rounded-none border-0 text-muted-foreground hover:bg-accent hover:text-accent-foreground data-[state=active]:bg-muted data-[state=active]:text-foreground data-[state=active]:shadow-none"
						onauxclick={(e) => handleAuxClick(e, fileId)}
					>
						<span class="mr-4">{row.name}</span>
						<button
							type="button"
							class="absolute right-1 top-1/2 -translate-y-1/2 rounded-sm p-0.5 opacity-50 hover:opacity-100 hover:bg-accent"
							onclick={(e) => handleClose(e, fileId)}
							aria-label="Close {row.name}"
						>
							<XIcon class="h-3 w-3" />
						</button>
					</Tabs.Trigger>
				{/if}
			{/each}
		</Tabs.List>
	</Tabs.Root>
{/if}
