<script lang="ts">
	import { Loading } from '@epicenter/ui/loading';
	import { isOk } from 'wellcrafted/result';
	import { openLocalDatabase } from '$lib/databases.js';
	import HoneycrispProvider from '$lib/HoneycrispProvider.svelte';
	import StoreShell from '../components/StoreShell.svelte';
	import StoreFailure from '../components/StoreFailure.svelte';

	const opening = openLocalDatabase();

	$effect(() => {
		return () => {
			void opening.then((result) => {
				if (isOk(result)) void result.data[Symbol.asyncDispose]();
			});
		};
	});
</script>

{#await opening}
	<Loading class="h-dvh" label="Opening notes on this device…" />
{:then result}
	{#if isOk(result)}
		<HoneycrispProvider data={result.data.data}>
			<StoreShell
				storeLabel="On this device"
				otherStoreLabel="Across your devices"
				otherStoreHref="/account"
			/>
		</HoneycrispProvider>
	{:else}
		<StoreFailure store="local" error={result.error} />
	{/if}
{:catch error}
	<StoreFailure store="local" {error} />
{/await}
