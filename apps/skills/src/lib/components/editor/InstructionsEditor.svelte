<script lang="ts">
	import { Spinner } from '@epicenter/ui/spinner';
	import type { DocumentHandle } from '@epicenter/workspace';
	import { workspace } from '$lib/client';
	import { skillsState } from '$lib/state/skills-state.svelte';
	import CodeMirrorEditor from './CodeMirrorEditor.svelte';

	let { skillId }: { skillId: string } = $props();

	let handle = $state<DocumentHandle | null>(null);
	let error = $state<string | null>(null);

	$effect(() => {
		const id = skillId;
		handle = null;
		error = null;
		workspace.documents.skills.instructions.open(id).then(
			(h) => {
				if (skillsState.selectedSkillId !== id) return;
				handle = h;
			},
			(err) => {
				console.error('Failed to open instructions document:', err);
				error = err instanceof Error ? err.message : 'Failed to open document';
			},
		);
	});
</script>

{#if error}
	<div class="flex h-full items-center justify-center">
		<p class="text-sm text-destructive">{error}</p>
	</div>
{:else if handle}
	<CodeMirrorEditor ytext={handle.asText()} />
{:else}
	<div class="flex h-full items-center justify-center">
		<Spinner class="size-5 text-muted-foreground" />
	</div>
{/if}
