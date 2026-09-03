<script lang="ts">
	import type { Snippet } from 'svelte';
	import { createHoneycrisp, setHoneycrisp } from './app.svelte.js';
	import type { HoneycrispData } from './data/index.js';

	let {
		data,
		children,
	}: {
		data: HoneycrispData;
		children: Snippet;
	} = $props();

	// The opened store stops here. This component turns it into the reactive
	// application object and provides that instead, so descendants consume
	// `getHoneycrisp()` and nothing below can reach a raw write verb, the `kv`
	// root, or the document's disposal. Read once, not `$derived`: the route
	// mounts this exactly once per opened store, so the prop never changes while
	// this component lives.
	/* svelte-ignore state_referenced_locally */
	setHoneycrisp(createHoneycrisp({ data }));
</script>

{@render children()}
