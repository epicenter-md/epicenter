<script lang="ts">
	import { CannotOpenScreen } from '@epicenter/app-shell/boot-screens';
	import { Loading } from '@epicenter/ui/loading';
	import { epicenter } from '$lib/epicenter.svelte.js';
	import VocabShell from './VocabShell.svelte';

	/**
	 * One session, for one principal.
	 *
	 * Opened in the script body because the parent keys this on the principal,
	 * so a new principal is a new instance. The handle serializes, so this open
	 * runs after the previous session's release even though Svelte creates the
	 * new keyed branch first.
	 */
	let session = $state.raw(epicenter.open());
	$effect(() => () => void session.close());

	/** Erase this account's copy, then open a fresh one. */
	async function forgetDevice() {
		const erased = await session.erase();
		session = epicenter.open();
		if (erased.error !== null) throw erased.error;
	}
</script>

{#await session.opened}
	<Loading class="h-dvh" label="Opening your conversations…" />
{:then { data, error }}
	{#if error !== null}
		<CannotOpenScreen
			appName="Vocab"
			noun="conversations"
			{error}
			retry={() => (session = epicenter.open())}
		/>
	{:else}
		<VocabShell {data} {forgetDevice} />
	{/if}
{/await}
