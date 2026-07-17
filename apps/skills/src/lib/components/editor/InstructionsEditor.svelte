<script lang="ts">
	import { skills } from '$lib/skills/client';
	import CodeMirrorEditor from './CodeMirrorEditor.svelte';

	let { skillId }: { skillId: string } = $props();

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
