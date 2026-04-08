<script lang="ts">
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { onDestroy, onMount } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { goto } from '$app/navigation';
	import { migrateOldSettings } from '$lib/migration/migrate-settings';
	import { rpc } from '$lib/query';
	import { services } from '$lib/services';
	import AppLayout from './_components/AppLayout.svelte';
	import BottomNav from './_components/BottomNav.svelte';
	import VerticalNav from './_components/VerticalNav.svelte';

	// Migrate old monolithic settings blob to per-key stores (one-time, idempotent)
	migrateOldSettings();

	let { children } = $props();

	let sidebarOpen = $state(false);
	let unlistenNavigate: UnlistenFn | null = null;

	// Sidebar when wide, bottom bar on narrow viewports (phone, small window).
	const isNarrow = new MediaQuery('(max-width: 767px)');

	$effect(() => {
		const unlisten = services.localShortcutManager.listen();
		return () => unlisten();
	});

	// Log app started event once on mount
	$effect(() => {
		rpc.analytics.logEvent({ type: 'app_started' });
	});

	// Listen for navigation events from other windows
	onMount(async () => {
		if (!window.__TAURI_INTERNALS__) return;
		unlistenNavigate = await listen<{ path: string }>(
			'navigate-main-window',
			(event) => {
				goto(event.payload.path);
			},
		);
	});

	onDestroy(() => {
		unlistenNavigate?.();
	});
</script>

{#if isNarrow.current}
	<div class="flex h-full min-h-svh flex-col">
		<div class="flex-1 pb-14">
			<AppLayout> {@render children()} </AppLayout>
		</div>
		<BottomNav />
	</div>
{:else}
	<Sidebar.Provider bind:open={sidebarOpen}>
		<VerticalNav />
		<Sidebar.Inset>
			<AppLayout> {@render children()} </AppLayout>
		</Sidebar.Inset>
	</Sidebar.Provider>
{/if}
