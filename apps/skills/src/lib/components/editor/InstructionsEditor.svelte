<script lang="ts">
	import { SKILL_CONTENT } from '@epicenter/skills';
	import { getSkills } from '$lib/context.js';
	import CodeMirrorEditor from './CodeMirrorEditor.svelte';

	let { skillId }: { skillId: string } = $props();
	const skills = getSkills();

	// The skill's markdown, live. There is no lease to open, nothing to await,
	// and nothing to release: the root was allocated with the row (ADR-0215) and
	// it lives in the application's one document. Undefined means the row is
	// gone, which the editor renders as nothing rather than as an empty file it
	// could then save over.
	const content = $derived(
		skills.data.tables.skills.document(skillId)?.get(SKILL_CONTENT),
	);
</script>

{#if content !== undefined}
	{#key skillId}
		<CodeMirrorEditor {content} />
	{/key}
{/if}
