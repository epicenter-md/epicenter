<script lang="ts">
	import type { Snippet } from 'svelte';
	import { createHoneycrisp, setHoneycrisp } from './app.svelte.js';
	import type { AccountDatabase, DeviceDatabase } from './databases.js';

	let {
		data,
		children,
	}: {
		data: AccountDatabase['data'] | DeviceDatabase['data'];
		children: Snippet;
	} = $props();

	// The opened database stops here. This component turns one route generation's
	// single data capability into the reactive application object and provides that
	// instead, so descendants
	// consume `getHoneycrisp()` and nothing below can reach the raw store or
	// sync plane. Read once, not `$derived`: the route mounts this exactly once
	// per resolved database, so the prop never changes while this component lives.
	/* svelte-ignore state_referenced_locally */
	setHoneycrisp(createHoneycrisp({ data }));
</script>

{@render children()}
