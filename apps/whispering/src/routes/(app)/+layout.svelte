<script lang="ts">
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { MediaQuery } from 'svelte/reactivity';
	import DictationIndicator from '#platform/dictation-indicator';
	import AppEffects from './_components/AppEffects.svelte';
	import BottomNav from './_components/BottomNav.svelte';
	import ContentShell from './_components/ContentShell.svelte';
	import GlobalDialogs from './_components/GlobalDialogs.svelte';
	import VerticalNav from './_components/VerticalNav.svelte';

	let { children } = $props();

	let sidebarOpen = $state(false);

	// Sidebar when wide, bottom bar on narrow viewports (phone, small window).
	const isNarrow = new MediaQuery('(max-width: 767px)');
</script>

<!--
	The (app) route layout is the session root. It mounts once and persists
	across navigation and across the responsive branch below, so AppEffects,
	GlobalDialogs, and the build-selected DictationIndicator start exactly once per
	launch. Only the nav chrome and ContentShell swap on a breakpoint change.
-->
<AppEffects />

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
<DictationIndicator />
