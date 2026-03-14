<script lang="ts">
	import { fsState } from '$lib/fs/fs-state.svelte';
	import ContentEditor from './ContentEditor.svelte';
	import PathBreadcrumb from './PathBreadcrumb.svelte';
	import TabBar from './TabBar.svelte';
</script>

<div class="flex h-full flex-col">
	<TabBar />

	{#if fsState.activeFileId && fsState.selectedNode}
		<div class="flex items-center border-b px-4 py-2"><PathBreadcrumb /></div>

		{#if fsState.selectedNode.type === 'folder'}
			<div
				class="flex flex-1 items-center justify-center text-sm text-muted-foreground"
			>
				Select a file to view its contents
			</div>
		{:else}
			<div class="flex-1 overflow-hidden">
				{#key fsState.activeFileId}
					<ContentEditor fileId={fsState.activeFileId} />
				{/key}
			</div>
		{/if}
	{:else}
		<div
			class="flex h-full items-center justify-center text-sm text-muted-foreground"
		>
			<div class="text-center">
				<p>No file selected</p>
				<p class="mt-1 text-xs">
					Click a file in the tree to view its contents
				</p>
			</div>
		</div>
	{/if}
</div>
