<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HoneycrispApplication } from './application.js';
	import { setHoneycrispApp } from './context.js';

	let {
		application,
		children,
	}: { application: HoneycrispApplication; children: Snippet } = $props();

	/* svelte-ignore state_referenced_locally */
	setHoneycrispApp(application);
</script>

{@render children()}
