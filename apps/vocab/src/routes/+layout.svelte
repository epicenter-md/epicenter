<script lang="ts">
	import { FlushEditsOnHide } from '@epicenter/svelte';
	import { reloadOnAuthChange } from '@epicenter/svelte/auth';
	import { Button } from '@epicenter/ui/button';
	import { ConfirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Loading } from '@epicenter/ui/loading';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { ModeWatcher } from 'mode-watcher';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { auth } from '$lib/platform/auth';
	import { openVocabRuntime } from '$lib/runtime';
	import VocabAppProvider from '$lib/VocabAppProvider.svelte';
	import '../app.css';

	let { children } = $props();

	// One transactional open acquired during layout initialisation, and a raw
	// `{#await}` owning pending, ready and failure; descendants receive the
	// READY runtime through a typed context.
	//
	// Gated rather than skeletoned because there is no useful partial UI. The
	// same gate deliberately holds a signed-in generation whose fresh account
	// replica has not bound yet, device data included: a partial-ready surface
	// is refused, and the way back to device-only use is a new generation
	// (signing out).
	const boot = new AbortController();
	const opening = openVocabRuntime({ auth, signal: boot.signal });
	$effect(() => () => boot.abort());

	// A page lifetime is one auth generation (ADR-0232). Everything above
	// composed itself from the boot-time auth snapshot, so an identity change or
	// a repaired credential reloads rather than swapping anything in place; the
	// next boot rebuilds the right documents and sync from scratch.
	$effect(() => reloadOnAuthChange(auth));
</script>

<svelte:head><title>Vocab</title></svelte:head>

{#await opening}
	<Loading class="h-dvh" />
{:then runtime}
	<VocabAppProvider {runtime}>
		<Tooltip.Provider>{@render children?.()}</Tooltip.Provider>
	</VocabAppProvider>
{:catch error}
	<div
		class="flex h-dvh flex-col items-center justify-center gap-4 p-8 text-center"
	>
		<h1 class="text-lg font-semibold">Vocab could not start</h1>
		<p class="text-muted-foreground max-w-md text-sm">
			<!-- `extractErrorMessage`, not `String(error)`: a tagged error is a plain
			     object with a `message`, so stringifying one renders
			     "[object Object]" and hides the only useful thing it carries. -->
			{extractErrorMessage(error)}
		</p>
		<div class="flex gap-2">
			<Button onclick={() => location.reload()}>Reload</Button>
			<Button variant="outline" onclick={() => auth.signOut()}>Sign out</Button>
		</div>
	</div>
{/await}

<Toaster />
<ConfirmationDialog />
<ModeWatcher />
<FlushEditsOnHide />
