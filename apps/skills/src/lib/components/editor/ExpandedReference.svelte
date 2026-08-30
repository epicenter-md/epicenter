<script lang="ts">
	import { SKILL_CONTENT } from '@epicenter/skills';
	import { getSkills } from '$lib/context.js';
	import CodeMirrorEditor from './CodeMirrorEditor.svelte';

	let { id }: { id: string } = $props();
	const skills = getSkills();

	// Same shape as InstructionsEditor: the body is a nested type on the row
	// (ADR-0295), so there is nothing to open and nothing to dispose.
	const content = $derived(
		skills.data.tables.skillReferences.content(id)?.types[SKILL_CONTENT],
	);
</script>

<div class="h-48 border-t">
	{#if content !== undefined}
		{#key id}
			<CodeMirrorEditor {content} />
		{/key}
	{/if}
</div>
