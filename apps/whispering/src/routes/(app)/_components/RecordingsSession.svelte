<script lang="ts">
	import { CannotOpenScreen } from '@epicenter/app-shell/boot-screens';
	import { Loading } from '@epicenter/ui/loading';
	import { epicenter } from '$lib/epicenter.svelte';
	import WhisperingShell from './WhisperingShell.svelte';

	/**
	 * One session, for one principal.
	 *
	 * Opened in the script body because the parent keys this on the principal,
	 * so a new principal is a new instance. The handle serializes, so this open
	 * runs after the previous session's release even though Svelte creates the
	 * new keyed branch before destroying the old one.
	 */
	let { children } = $props();

	let session = $state.raw(epicenter.open());
	$effect(() => () => void session.close());
</script>

{#await session.opened}
	<Loading class="h-dvh" label="Opening your recordings…" />
{:then { data, error }}
	{#if error !== null}
		<CannotOpenScreen
			appName="Whispering"
			noun="recordings"
			{error}
			retry={() => (session = epicenter.open())}
		/>
	{:else}
		<WhisperingShell {data}>{@render children()}</WhisperingShell>
	{/if}
{/await}
