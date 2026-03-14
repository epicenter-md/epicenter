<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Dialog from '@epicenter/ui/dialog';
	import { Field, FieldLabel } from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import { fsState } from '$lib/fs/fs-state.svelte';

	type Props = {
		open: boolean;
		mode: 'file' | 'folder';
	};

	let { open = $bindable(false), mode }: Props = $props();
	let name = $state('');

	const title = $derived(mode === 'file' ? 'New File' : 'New Folder');

	async function handleSubmit(e: Event) {
		e.preventDefault();
		if (!name.trim()) return;

		const parentId =
			fsState.selectedNode?.type === 'folder' ? fsState.activeFileId : null;

		if (mode === 'file') {
			await fsState.actions.createFile(parentId, name.trim());
		} else {
			await fsState.actions.createFolder(parentId, name.trim());
		}

		name = '';
		open = false;
	}

	function handleOpenChange(isOpen: boolean) {
		open = isOpen;
		if (!isOpen) name = '';
	}
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>{title}</Dialog.Title>
			<Dialog.Description>
				Enter a name for the new {mode}.
			</Dialog.Description>
		</Dialog.Header>
		<form onsubmit={handleSubmit}>
			<Field>
				<FieldLabel>Name</FieldLabel>
				<Input
					type="text"
					placeholder={mode === 'file' ? 'filename.txt' : 'folder-name'}
					bind:value={name}
					autofocus
				/>
			</Field>
			<Dialog.Footer class="mt-4">
				<Button variant="outline" type="button" onclick={() => (open = false)}>
					Cancel
				</Button>
				<Button type="submit" disabled={!name.trim()}>Create</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
