<script lang="ts">
	import { SKILL_CONTENT } from '@epicenter/skills';
	import { getSkills } from '$lib/context.js';
	import CodeMirrorEditor from './CodeMirrorEditor.svelte';

	let { id }: { id: string } = $props();
	const skills = getSkills();

	// Same open-per-row lifecycle as InstructionsEditor (ADR-0248).
	type Opened = Awaited<
		ReturnType<typeof skills.data.tables.skillReferences.openDocument>
	>['data'];
	let opened = $state.raw<Opened | 'loading'>('loading');
	$effect(() => {
		let stale = false;
		opened = 'loading';
		void skills.data.tables.skillReferences
			.openDocument(id)
			.then((result) => {
				if (result.error !== null) throw result.error;
				if (stale) {
					result.data?.[Symbol.dispose]();
					return;
				}
				opened = result.data;
			});
		return () => {
			stale = true;
			if (opened !== 'loading') opened?.[Symbol.dispose]();
		};
	});
</script>

<div class="h-48 border-t">
	{#if opened !== 'loading' && opened !== undefined && opened !== null}
		{#key id}
			<CodeMirrorEditor content={opened.get(SKILL_CONTENT)} />
		{/key}
	{/if}
</div>
