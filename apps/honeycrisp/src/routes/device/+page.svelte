<script lang="ts">
	import { Loading } from '@epicenter/ui/loading';
	import { isOk } from 'wellcrafted/result';
	import { openDeviceDatabase } from '$lib/databases.js';
	import HoneycrispProvider from '$lib/HoneycrispProvider.svelte';
	import Workspace from '../components/Workspace.svelte';
	import WorkspaceFailure from '../components/WorkspaceFailure.svelte';

	const opening = openDeviceDatabase();

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
			<Workspace
				workspaceLabel="On this device"
				otherWorkspaceLabel="Across your devices"
				otherWorkspaceHref="/account"
			/>
		</HoneycrispProvider>
	{:else}
		<WorkspaceFailure workspace="device" error={result.error} />
	{/if}
{:catch error}
	<WorkspaceFailure workspace="device" {error} />
{/await}
