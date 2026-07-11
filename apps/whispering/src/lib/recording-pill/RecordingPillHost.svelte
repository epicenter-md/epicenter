<script lang="ts">
	import { dispatchPillAction } from '$lib/recording-pill/pill-actions';
	import RecordingPill from '$lib/recording-pill/RecordingPill.svelte';
	import { projectLifecycleToStatus } from '$lib/recording-pill/projection';
	import { webPillLevel } from '$lib/recording-pill/web-level.svelte';
	import { dictationLifecycle } from '$lib/state/dictation-lifecycle.svelte';

	// The web mount of the shared dictation pill. The app layout mounts this host
	// only in the browser build. It places `RecordingPill` at the bottom center and
	// drives it straight from the lifecycle value, routing gestures through
	// `pill-actions` with no status synchronization or IPC.
	// The pill body has no reveal action on web: the app window is already in
	// front, and a failure is surfaced by the notification and the recordings row.
	const status = $derived(projectLifecycleToStatus(dictationLifecycle.current));
</script>

{#if status}
	<!-- Bottom-center, matching the desktop overlay's resting position
	     (OVERLAY_BOTTOM_MARGIN). Above page content, below modals and toasts. -->
	<div class="fixed bottom-[72px] left-1/2 z-50 -translate-x-1/2">
		<RecordingPill
			{status}
			level={webPillLevel.level}
			onStop={() => dispatchPillAction('stop')}
			onCancel={() => dispatchPillAction('cancel')}
			onShipRaw={() => dispatchPillAction('ship-raw')}
		/>
	</div>
{/if}
