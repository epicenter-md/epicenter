<script lang="ts">
	import type { FileId } from '@epicenter/filesystem';
	import type { DocumentHandle } from '@epicenter/workspace';
	import { fsState } from '$lib/fs/fs-state.svelte';
	import CodeMirrorEditor from './CodeMirrorEditor.svelte';

	let { fileId }: {
		fileId: FileId;
	} = $props();

	let handle = $state<DocumentHandle | null>(null);

	$effect(() => {
		const id = fileId;
		handle = null;
		fsState.documents.open(id).then((h) => {
			// Guard against race condition -- if file changed while loading, ignore
			if (fsState.activeFileId !== id) return;
			handle = h;
		});
	});
</script>

{#if handle}
	<CodeMirrorEditor ytext={handle.asText()} />
{:else}
	<div class="flex h-full items-center justify-center text-sm text-muted-foreground">
		Loading...
	</div>
{/if}
