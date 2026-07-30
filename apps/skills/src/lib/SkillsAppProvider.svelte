<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { SkillsApplication } from './application.js';
	import { setSkillsApp } from './context.js';

	let {
		application,
		children,
	}: { application: SkillsApplication; children: Snippet } = $props();

	/* svelte-ignore state_referenced_locally */
	setSkillsApp(application);
</script>

{@render children()}
