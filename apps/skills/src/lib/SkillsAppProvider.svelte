<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { SkillsRuntime } from './application.js';
	import { setSkills } from './context.js';

	let {
		runtime,
		children,
	}: { runtime: SkillsRuntime; children: Snippet } = $props();

	/* svelte-ignore state_referenced_locally */
	setSkills(runtime);
</script>

{@render children()}
