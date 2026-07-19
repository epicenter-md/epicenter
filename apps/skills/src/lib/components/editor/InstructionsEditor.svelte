<script lang="ts">
	import { getSkillsApp } from '$lib/context.js';
	import CodeMirrorEditor from './CodeMirrorEditor.svelte';

	let { skillId }: { skillId: string } = $props();
	const skills = getSkillsApp();

	const lease = $derived(skills.tables.skills.document.open(skillId));
	$effect(() => {
		const openedLease = lease;
		return () =>
			void openedLease.then(
				(opened) => opened[Symbol.dispose](),
				() => undefined,
			);
	});
</script>

{#await lease then opened}
	<CodeMirrorEditor document={opened} />
{/await}
