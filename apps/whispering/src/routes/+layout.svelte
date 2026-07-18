<script lang="ts">
	import {
		StorageMovedScreen,
		storageMoved,
	} from '@epicenter/app-shell/storage-moved';
	import { Toaster } from '@epicenter/ui/sonner';
	import { QueryClientProvider } from '@tanstack/svelte-query';
	import { ModeWatcher } from 'mode-watcher';
	import { onMount } from 'svelte';
	import { auth } from '#platform/auth';
	import { onNavigate } from '$app/navigation';
	import { FlushEditsOnHide } from '@epicenter/svelte';
	import { reloadOnPrincipalChange } from '@epicenter/svelte/auth';
	import { queryClient } from '$lib/rpc/client';
	import '@epicenter/ui/app.css';
	// Whispering's brand overrides, layered after the shared theme so they win.
	// Keep this import last among the stylesheets.
	import '../app.css';
	import * as Tooltip from '@epicenter/ui/tooltip';

	let { children } = $props();

	// Option A: the active preset is picked once at boot; a
	// principal identity change reloads so the next boot rebuilds the right doc.
	onMount(() => reloadOnPrincipalChange(auth));

	onNavigate((navigation) => {
		if (!document.startViewTransition) return;
		// We deliberately lengthen the morph below, so honor reduced-motion by
		// skipping the transition entirely (snap to the new page) rather than
		// playing a longer animation for someone who asked for less.
		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

		return new Promise((resolve) => {
			document.startViewTransition(async () => {
				resolve();
				await navigation.complete;
			});
		});
	});
</script>

<svelte:head> <title>Whispering</title> </svelte:head>

{#if storageMoved.current}
	<StorageMovedScreen />
{:else}
	<QueryClientProvider client={queryClient}>
		<!-- Uses UI package defaults (300ms delay, 150ms skip) -->
		<Tooltip.Provider> {@render children()} </Tooltip.Provider>
	</QueryClientProvider>
{/if}

<Toaster
	offset={16}
	class="block"
	duration={5000}
	visibleToasts={5}
	closeButton
	toastOptions={{
		classes: {
			toast: 'flex flex-wrap *:data-content:flex-1',
			icon: 'shrink-0',
			actionButton: 'w-full mt-3 inline-flex justify-center',
			closeButton: 'w-full mt-3 inline-flex justify-center',
		},
	}}
/>
<ModeWatcher defaultMode="dark" track={false} />
<FlushEditsOnHide />

<style>
	/* The default UA view-transition runs 0.25s, which is abrupt for the
	   cross-page glyph morphs (ADR 0014) that fly the hero record control up
	   into the topbar. Slow every group and its old/new images by the same
	   amount so the named glyphs and the page crossfade stay in step. This is
	   the one knob: SvelteKit has no duration setting, it is pure CSS on the
	   :root view-transition pseudo-elements (hence :global).

	   0.3s is Material's inter-screen standard and sits in the middle of the
	   100-400ms band research calls responsive (NN/g: 500ms reads as a drag);
	   a gentle nudge up from the abrupt 0.25s UA default. */
	:global(::view-transition-group(*)),
	:global(::view-transition-old(*)),
	:global(::view-transition-new(*)) {
		animation-duration: 0.3s;
	}
</style>
