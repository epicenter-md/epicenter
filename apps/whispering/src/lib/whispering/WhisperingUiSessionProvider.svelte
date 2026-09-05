<!--
	The UI session's lifetime, made a component.

	Mounted only in the `ready` branch of the (app) layout's boot, so `data` is
	an open store from the moment this initialises: the session is built during
	initialisation, its typed context is supplied synchronously, and the
	session-owned TanStack client is installed for the descendant tree.

	It owns the teardown for exactly what it built. The replica underneath is NOT
	its to close: that is the document's (ADR-0088), and `$lib/epicenter.svelte.ts`
	holds the only reference that could end it.
-->
<script lang="ts">
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { onDestroy, type Snippet } from 'svelte';
	import { createLogger } from 'wellcrafted/logger';
	import { BlobsLive } from '#platform/blobs';
	import { setWhisperingContext } from './context';
	import type { WhisperingAccountData } from './app';
	import {
		createWhisperingUiSession,
		WhisperingUiSessionError,
	} from './ui-session';

	const log = createLogger('whispering/ui-session');

	let {
		data,
		children,
	}: {
		data: WhisperingAccountData;
		children: Snippet;
	} = $props();

	// One mount creates one immutable session/provider pair. `data` is the store
	// this branch was entered with; a different store means a different document.
	/* svelte-ignore state_referenced_locally */
	const session = createWhisperingUiSession({ data, blobs: BlobsLive });

	setWhisperingContext({ app: session.app, queries: session.queries });

	onDestroy(() =>
		void session[Symbol.asyncDispose]().catch((cause: unknown) => {
			log.warn(WhisperingUiSessionError.TeardownFailed({ cause }));
		}),
	);
</script>

<QueryClientProvider client={session.queryClient}>
	{@render children()}
</QueryClientProvider>
