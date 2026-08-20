<script lang="ts">
	import { SKILL_CONTENT } from '@epicenter/skills';
	import { getSkills } from '$lib/context.js';
	import CodeMirrorEditor from './CodeMirrorEditor.svelte';

	let { skillId }: { skillId: string } = $props();
	const skills = getSkills();

	// The skill's markdown, opened per skill. The open resolves only after
	// complete local hydration (ADR-0248), so the editor never binds to a
	// half-hydrated document. Undefined means the row is gone, which renders
	// as nothing rather than as an empty file it could then save over.
	type Opened = Awaited<
		ReturnType<typeof skills.data.tables.skills.document.open>
	>['data'];
	let opened = $state.raw<Opened | 'loading'>('loading');
	$effect(() => {
		let stale = false;
		opened = 'loading';
		void skills.data.tables.skills.document.open(skillId).then((result) => {
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

{#if opened !== 'loading' && opened !== undefined && opened !== null}
	{#key skillId}
		<CodeMirrorEditor content={opened.get(SKILL_CONTENT)} />
	{/key}
{/if}
