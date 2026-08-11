<script lang="ts">
	import type { Snippet } from 'svelte';
	import { setVocabRuntime } from './context.js';
	import type { VocabRuntime } from './runtime.js';

	let { runtime, children }: { runtime: VocabRuntime; children: Snippet } =
		$props();

	/* svelte-ignore state_referenced_locally */
	setVocabRuntime(runtime);
</script>

{@render children()}
