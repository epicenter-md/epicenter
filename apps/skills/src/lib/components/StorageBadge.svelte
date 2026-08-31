<script lang="ts">
	import { Database } from '@lucide/svelte';
	import { getSkills } from '$lib/context.js';

	const { state: skillsState } = getSkills();
</script>

<div
	class="flex items-center gap-1.5 border-t px-3 py-1.5 text-xs text-muted-foreground"
>
	<Database class="size-3 shrink-0" />
	<span>
		{skillsState.skills.length}
		{skillsState.skills.length === 1 ? 'skill' : 'skills'}
		{#if skillsState.nonconforming.length > 0}
			<span class="text-muted-foreground/60">·</span>
			<span class="text-destructive">
				{skillsState.nonconforming.length} invalid
			</span>
		{/if}
	</span>
</div>
