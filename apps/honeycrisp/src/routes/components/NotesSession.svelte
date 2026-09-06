<script lang="ts">
	import { CannotOpenScreen } from '@epicenter/app-shell/boot-screens';
	import { Loading } from '@epicenter/ui/loading';
	import { epicenter } from '$lib/epicenter.svelte.js';
	import StoreShell from './StoreShell.svelte';

	/**
	 * One session, for one principal.
	 *
	 * Opened in the script body rather than an effect, because the parent keys
	 * this component on the principal, so a new principal is a new instance and
	 * the body is the one thing that runs per instance. That is safe despite
	 * Svelte creating the new keyed branch before destroying the old one: the
	 * handle serializes, so this open runs after the previous session's release.
	 *
	 * The cleanup-only effect is the whole lifecycle. Closing releases the Web
	 * Lock, the socket, and the page-hide listener together (ADR-0340).
	 */
	let session = $state.raw(epicenter.open());
	$effect(() => () => void session.close());

	/**
	 * Erase this account's copy, then open a fresh one.
	 *
	 * A success bootstraps an empty replica from the account; a failure leaves
	 * the copy that is still there and reopens it. Either way the reopen is this
	 * component's move rather than the handle's, because the handle cannot swap
	 * a value a component owns.
	 */
	async function forgetDevice() {
		const erased = await session.erase();
		session = epicenter.open();
		if (erased.error !== null) throw erased.error;
	}
</script>

{#await session.opened}
	<Loading class="h-dvh" label="Opening your notes…" />
{:then { data, error }}
	{#if error !== null}
		<CannotOpenScreen
			appName="Honeycrisp"
			noun="notes"
			{error}
			retry={() => (session = epicenter.open())}
		/>
	{:else}
		<StoreShell {data} {forgetDevice} />
	{/if}
{/await}
