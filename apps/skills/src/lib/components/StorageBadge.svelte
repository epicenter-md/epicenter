<script lang="ts">
	import { Database } from '@lucide/svelte';
	import { getSkillsApp } from '$lib/context.js';

	const { state: skillsState } = getSkillsApp();
</script>

<div
	class="flex items-center gap-1.5 border-t px-3 py-1.5 text-xs text-muted-foreground"
>
	<Database class="size-3 shrink-0" />
	<span>
		{#if skillsState.loadError}
			<span class="text-destructive">Load failed</span>
		{:else}
			{skillsState.skills.length}
			{skillsState.skills.length === 1 ? 'skill' : 'skills'}
		{/if}
		{#if !skillsState.loadError && skillsState.nonconforming.length > 0}
			<span class="text-muted-foreground/60">·</span>
			<span class="text-destructive">
				{skillsState.nonconforming.length} invalid
			</span>
		{/if}
	</span>
</div>
