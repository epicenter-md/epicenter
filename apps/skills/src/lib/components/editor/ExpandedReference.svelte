<script lang="ts">
	import { SKILL_CONTENT } from '@epicenter/skills';
	import { getSkills } from '$lib/context.js';
	import CodeMirrorEditor from './CodeMirrorEditor.svelte';

	let { id }: { id: string } = $props();
	const skills = getSkills();

	const content = $derived(
		skills.data.tables.skillReferences.document(id)?.get(SKILL_CONTENT),
	);
</script>

<div class="h-48 border-t">
	{#if content !== undefined}
		{#key id}
			<CodeMirrorEditor {content} />
		{/key}
	{/if}
</div>
