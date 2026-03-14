<script lang="ts">
	import * as AlertDialog from '@epicenter/ui/alert-dialog';
	import { Button } from '@epicenter/ui/button';
	import { fsState } from '$lib/fs/fs-state.svelte';

	type Props = {
		open: boolean;
	};

	let { open = $bindable(false) }: Props = $props();

	const nodeName = $derived(fsState.selectedNode?.name ?? 'this item');
	const nodeType = $derived(fsState.selectedNode?.type ?? 'file');

	async function handleDelete() {
		if (!fsState.activeFileId) return;
		await fsState.actions.deleteFile(fsState.activeFileId);
		open = false;
	}
</script>

<AlertDialog.Root bind:open>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete {nodeName}?</AlertDialog.Title>
			<AlertDialog.Description>
				{#if nodeType === 'folder'}
					This will delete the folder and all its contents. This action cannot
					be undone.
				{:else}
					This will delete the file. This action cannot be undone.
				{/if}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<Button variant="destructive" onclick={handleDelete}>Delete</Button>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
