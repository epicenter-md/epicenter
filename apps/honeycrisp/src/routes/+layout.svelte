<script lang="ts">
	import { FlushEditsOnHide } from '@epicenter/svelte';
	import { reloadOnAuthChange } from '@epicenter/svelte/auth';
	import { Loading } from '@epicenter/ui/loading';
	import { Toaster } from '@epicenter/ui/sonner';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import { ModeWatcher } from 'mode-watcher';
	import { extractErrorMessage } from 'wellcrafted/error';
	import { auth } from '#platform/auth';
	import HoneycrispProvider from '$lib/HoneycrispProvider.svelte';
	import { bootFailureMessage } from '$lib/boot-failure.js';
	import { openHoneycrispDatabases } from '$lib/databases.js';
	import '@epicenter/ui/app.css';

	let { children } = $props();

	// The generation's databases: one transactional open acquired during
	// layout initialisation, and a raw `{#await}` owning pending, ready and
	// failure; the provider turns the ready databases into the reactive Honeycrisp
	// application and provides that through a typed context, so there is no
	// module-scope boot, no half-open handle, and no `whenReady` accessor for
	// anything to read too early.
	//
	// Gated rather than skeletoned because there is no useful partial UI: a
	// route on an unopened store reads empty tables and flashes "No notes yet"
	// at someone whose notes are about to appear. The same gate deliberately
	// holds a signed-in generation whose fresh account replica has not bound
	// yet, device data included: a partial-ready surface is refused, and the
	// way back to device-only use is a new generation (signing out).
	const boot = new AbortController();
	const opening = openHoneycrispDatabases({ auth, signal: boot.signal });
	$effect(() => () => boot.abort());

	// A page lifetime is one auth generation. Everything above composed itself
	// from the boot-time auth snapshot, so an identity change or a repaired
	// credential reloads rather than swapping anything in place; the next boot
	// opens the right documents and sync from scratch. On the desktop host
	// this never fires (identity is immutable per process generation,
	// ADR-0155).
	$effect(() => reloadOnAuthChange(auth));
</script>

<svelte:head><title>Honeycrisp</title></svelte:head>

{#await opening}
	<Loading class="h-dvh" />
{:then databases}
	<HoneycrispProvider {databases}>
		<Tooltip.Provider>{@render children?.()}</Tooltip.Provider>
	</HoneycrispProvider>
{:catch error}
	<div class="flex h-dvh items-center justify-center p-6 text-center">
		<div class="max-w-md space-y-2">
			<h1 class="text-lg font-semibold">Honeycrisp could not start</h1>
			<p class="text-sm text-muted-foreground">{bootFailureMessage(error)}</p>
			<!-- The library's own sentence, kept rather than swallowed. It is what
			     makes a bug report useful, and it is how anyone works out that the
			     friendlier line above picked the wrong arm.
			     `extractErrorMessage`, not `String(error)`: a tagged error is a
			     plain object with a `message`, so stringifying one renders
			     "[object Object]" and hides the only useful thing it carries. -->
			<p class="text-muted-foreground/70 text-xs">
				{extractErrorMessage(error)}
			</p>
		</div>
	</div>
{/await}

<Toaster offset={16} closeButton />
<ModeWatcher defaultMode="dark" track={false} />
<FlushEditsOnHide />
