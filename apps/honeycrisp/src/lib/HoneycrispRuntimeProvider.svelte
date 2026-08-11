<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HoneycrispRuntime } from './runtime.js';
	import { setHoneycrispRuntime } from './context.js';

	let {
		runtime,
		children,
	}: { runtime: HoneycrispRuntime; children: Snippet } = $props();

	/* svelte-ignore state_referenced_locally */
	setHoneycrispRuntime(runtime);
</script>

{@render children()}
