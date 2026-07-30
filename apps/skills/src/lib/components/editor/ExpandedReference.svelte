<script lang="ts">
	import { getSkillsApp } from '$lib/context.js';
	import CodeMirrorEditor from './CodeMirrorEditor.svelte';

	let { id }: { id: string } = $props();
	const skills = getSkillsApp();

	const lease = $derived(skills.tables.referenceFiles.openDocument(id));
	$effect(() => {
		const openedLease = lease;
		return () =>
			void openedLease.then(
				(opened) => opened[Symbol.asyncDispose](),
				() => undefined,
			);
	});
</script>

<div class="h-48 border-t">
	{#await lease then opened}
		<CodeMirrorEditor document={opened} />
	{/await}
</div>
