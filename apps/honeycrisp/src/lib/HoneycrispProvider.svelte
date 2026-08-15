<script lang="ts">
	import type { Snippet } from 'svelte';
	import { createHoneycrisp, setHoneycrisp } from './honeycrisp/index.js';
	import type { HoneycrispRuntime } from './runtime.js';

	let {
		runtime,
		children,
	}: { runtime: HoneycrispRuntime; children: Snippet } = $props();

	// The runtime stops here. This component turns one ready runtime into the
	// reactive application object and provides that instead, so descendants
	// consume `getHoneycrisp()` and nothing below can reach the raw store or
	// sync plane. Read once, not `$derived`: the layout mounts this exactly
	// once per resolved boot, and a page lifetime is one auth generation
	// (ADR-0232), so the prop never changes while this component lives.
	/* svelte-ignore state_referenced_locally */
	setHoneycrisp(createHoneycrisp({ runtime }));
</script>

{@render children()}
