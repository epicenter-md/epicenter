<script lang="ts">
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { MediaQuery } from 'svelte/reactivity';
	import { tauri } from '#platform/tauri';
	import AppRuntime from './_components/AppRuntime.svelte';
	import BottomNav from './_components/BottomNav.svelte';
	import ContentShell from './_components/ContentShell.svelte';
	import GlobalDialogs from './_components/GlobalDialogs.svelte';
	import VerticalNav from './_components/VerticalNav.svelte';
	import RecordingPillHost from '$lib/recording-pill/RecordingPillHost.svelte';

	let { children } = $props();

	let sidebarOpen = $state(false);

	// Sidebar when wide, bottom bar on narrow viewports (phone, small window).
	const isNarrow = new MediaQuery('(max-width: 767px)');
</script>

<!--
	The (app) route layout is the session root. It mounts once and persists
	across navigation and across the responsive branch below, so AppRuntime and
	GlobalDialogs (rendered outside the {#if}) start exactly once per launch. Only
	the nav chrome and ContentShell swap on a breakpoint change.
-->
<AppRuntime />

{#if isNarrow.current}
	<div class="flex h-full min-h-svh flex-col">
		<div class="flex-1 pb-14">
			<ContentShell>{@render children()}</ContentShell>
		</div>
		<BottomNav />
	</div>
{:else}
	<Sidebar.Provider bind:open={sidebarOpen}>
		<VerticalNav />
		<Sidebar.Inset>
			<ContentShell>{@render children()}</ContentShell>
		</Sidebar.Inset>
	</Sidebar.Provider>
{/if}

<GlobalDialogs />

{#if !tauri}
	<!-- The browser dictation pill persists across navigation as a session-root
	     sibling. Desktop uses the native overlay window instead. -->
	<RecordingPillHost />
{/if}
