<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { TabManagerApplication } from './application.js';
	import { setTabManagerApp } from './context.js';

	let {
		application,
		children,
	}: { application: TabManagerApplication; children: Snippet } = $props();

	/* svelte-ignore state_referenced_locally */
	setTabManagerApp(application);
</script>

{@render children()}
