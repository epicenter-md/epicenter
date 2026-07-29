<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { VocabApplication } from './application.js';
	import { setVocabApp } from './context.js';

	let {
		application,
		children,
	}: { application: VocabApplication; children: Snippet } = $props();

	/* svelte-ignore state_referenced_locally */
	setVocabApp(application);
</script>

{@render children()}
