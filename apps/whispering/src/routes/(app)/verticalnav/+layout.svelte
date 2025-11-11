<script lang="ts">
	import * as Sidebar from '@repo/ui/sidebar';
	import { rpc } from '$lib/query';
	import { createQuery } from '@tanstack/svelte-query';
	import VerticalNav from './+layout/VerticalNav.svelte';

	const getRecorderStateQuery = createQuery(
		rpc.recorder.getRecorderState.options,
	);
	const getVadStateQuery = createQuery(rpc.vadRecorder.getVadState.options);

	let { children } = $props();
</script>

<Sidebar.Provider>
	<VerticalNav {getRecorderStateQuery} {getVadStateQuery} />
	<Sidebar.Inset>
		<!-- Trigger button for mobile (always visible - opens Sheet) -->
		<div class="fixed left-2 top-2 z-40 md:hidden">
			<Sidebar.Trigger />
		</div>
		{@render children()}
	</Sidebar.Inset>
</Sidebar.Provider>

<style>
	/* Move Svelte Inspector to top-right for verticalnav */
	:global(#svelte-inspector-host button) {
		top: 16px !important;
		bottom: auto !important;
		right: 16px !important;
		left: auto !important;
		transform: none !important;
	}

	/* Move TanStack Query Devtools to bottom-right for verticalnav */
	:global(.tsqd-open-btn-container) {
		bottom: 16px !important;
		right: 16px !important;
		left: auto !important;
	}

	/* Position the NotificationLog button right above sidebar footer button */
	/* Make it invisible but keep it for popover anchor */
	:global(button.fixed.bottom-4.right-4.z-50.hidden.xs\:inline-flex) {
		opacity: 0 !important;
		pointer-events: none !important;
		/* Position it at the sidebar footer location */
		left: 16px !important;
		right: auto !important;
		bottom: 8px !important;
	}
</style>
