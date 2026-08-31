<script lang="ts">
	import { disposeOnUnmount } from '@epicenter/svelte';
	import { Loading } from '@epicenter/ui/loading';
	import { page } from '$app/state';
	import { openLocalDatabase } from '$lib/databases.js';
	import HoneycrispProvider from '$lib/HoneycrispProvider.svelte';
	import StoreShell from '../../components/StoreShell.svelte';
	import StoreFailure from '../../components/StoreFailure.svelte';

	// Read once. The generation is the address, so a different one is a
	// different database and a different route instance, never a store this
	// one rebinds underneath itself.
	const db = openLocalDatabase(Number(page.params.generation));
	// The route owns disposal (ADR-0233), and owning it is one line: the handle
	// is disposable before it is open, so nothing here reaches into a promise.
	disposeOnUnmount(db);
</script>

{#await db.ready}
	<Loading class="h-dvh" label="Opening notes on this device…" />
{:then { data }}
	<HoneycrispProvider {data}>
		<StoreShell
			storeLabel="On this device"
			otherStoreLabel="Across your devices"
			otherStoreHref="/account"
		/>
	</HoneycrispProvider>
{:catch error}
	<StoreFailure store="local" {error} />
{/await}
