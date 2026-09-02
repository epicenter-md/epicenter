<script lang="ts">
	import { disposeOnUnmount } from '@epicenter/svelte';
	import { Loading } from '@epicenter/ui/loading';
	import { auth } from '#platform/auth';
	import { page } from '$app/state';
	import AccountGate from '../../components/AccountGate.svelte';
	import StoreShell from '../../components/StoreShell.svelte';
	import HoneycrispProvider from '$lib/HoneycrispProvider.svelte';
	import { openAccountDatabase } from '$lib/databases.js';

	// Read once, on purpose. `reloadOnAuthChange` in the layout reloads the
	// document on every auth transition that invalidates this page, and refuses
	// to on the one that does not: `signed-in` degrading to `reauth-required`
	// keeps a working database, degraded, rather than tearing it down
	// mid-keystroke. Making this reactive would build a second, competing answer
	// to auth underneath the one the layout already gives, dead for the
	// transitions that reload and wrong for the one that deliberately doesn't.
	//
	// Signed-out is a state of this place, not a failure and not a different
	// place. Folding it into the rejection channel would make the gate sniff an
	// error to choose between "sign in" and "something broke", and a deep link
	// opened while signed out stays on its URL so the post-sign-in reload lands
	// exactly where the link pointed.
	const db =
		auth.state.status === 'signed-out'
			? null
			: openAccountDatabase({
					auth,
					generation: Number(page.params.generation),
				});
	// The route owns disposal (ADR-0233). One line, because the handle is
	// disposable before it is open: leaving mid-open closes the store that
	// finished opening behind us.
	if (db !== null) disposeOnUnmount(db);
</script>

{#if db === null}
	<AccountGate />
{:else}
	{#await db.ready}
		<Loading class="h-dvh" label="Opening your notes…" />
	{:then { data, syncStatus }}
		<HoneycrispProvider {data}>
			<StoreShell {syncStatus} />
		</HoneycrispProvider>
	{:catch error}
		<AccountGate {error} />
	{/await}
{/if}
