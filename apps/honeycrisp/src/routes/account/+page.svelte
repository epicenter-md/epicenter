<script lang="ts">
	import { Loading } from '@epicenter/ui/loading';
	import { isOk } from 'wellcrafted/result';
	import { auth } from '#platform/auth';
	import AccountGate from '../components/AccountGate.svelte';
	import StoreShell from '../components/StoreShell.svelte';
	import HoneycrispProvider from '$lib/HoneycrispProvider.svelte';
	import { openAccountDatabase } from '$lib/databases.js';

	const opening =
		auth.state.status === 'signed-out' ? null : openAccountDatabase({ auth });

	$effect(() => {
		if (opening === null) return;
		return () => {
			void opening.then((result) => {
				if (isOk(result)) void result.data[Symbol.asyncDispose]();
			});
		};
	});
</script>

{#if opening === null}
	<AccountGate />
{:else}
	{#await opening}
		<Loading class="h-dvh" label="Opening notes across your devices…" />
	{:then result}
		{#if isOk(result)}
			{#await result.data.ready}
				<Loading class="h-dvh" label="Preparing notes across your devices…" />
			{:then ready}
				{#if isOk(ready)}
					<HoneycrispProvider data={result.data.data}>
						<StoreShell
							storeLabel="Across your devices"
							otherStoreLabel="On this device"
							otherStoreHref="/device"
							syncStatus={result.data.syncStatus}
						/>
					</HoneycrispProvider>
				{:else}
					<AccountGate error={ready.error} />
				{/if}
			{:catch error}
				<AccountGate error={error} />
			{/await}
		{:else}
			<AccountGate error={result.error} />
		{/if}
	{:catch error}
		<AccountGate error={error} />
	{/await}
{/if}
