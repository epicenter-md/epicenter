<script lang="ts">
	import { FlushEditsOnHide } from '@epicenter/svelte';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Loading } from '@epicenter/ui/loading';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { ModeWatcher } from 'mode-watcher';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { auth } from '#platform/auth';
	import HoneycrispAppProvider from '$lib/HoneycrispAppProvider.svelte';
	import { openHoneycrispApplication } from '$lib/application.js';
	import '@epicenter/ui/app.css';

	let { children } = $props();

	// The ready-application shape. One transactional open acquired during layout
	// initialisation, and a raw `{#await}` owning pending, ready and failure;
	// descendants receive the READY application through a typed context, so
	// there is no module-scope boot, no half-open handle, and no `whenReady`
	// accessor for anything to read too early.
	//
	// Gated rather than skeletoned because there is no useful partial UI: a
	// route on an unopened store reads empty tables and flashes "No notes yet"
	// at someone whose notes are about to appear.
	const boot = new AbortController();
	const opening = openHoneycrispApplication({ auth, signal: boot.signal });
	$effect(() => () => boot.abort());
</script>

<svelte:head><title>Honeycrisp</title></svelte:head>

{#await opening}
	<Loading class="h-dvh" />
{:then application}
	<HoneycrispAppProvider {application}>
		<Tooltip.Provider>{@render children?.()}</Tooltip.Provider>
	</HoneycrispAppProvider>
{:catch error}
	<div class="flex h-dvh items-center justify-center p-6 text-center">
		<div class="max-w-md space-y-2">
			<h1 class="text-lg font-semibold">Honeycrisp could not start</h1>
			<p class="text-sm text-muted-foreground">
				<!-- `extractErrorMessage`, not `String(error)`: a tagged error is a
				     plain object with a `message`, so stringifying one renders
				     "[object Object]" and hides the only useful thing it carries. -->
				{extractErrorMessage(error)}
			</p>
		</div>
	</div>
{/await}

<Toaster offset={16} closeButton />
<ConfirmationDialog />
<ModeWatcher defaultMode="dark" track={false} />
<FlushEditsOnHide />
