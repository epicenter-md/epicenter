<script lang="ts">
	import { dispatchPillAction } from '$lib/recording-pill/pill-actions';
	import RecordingPill from '$lib/recording-pill/RecordingPill.svelte';
	import { projectLifecycleToStatus } from '$lib/recording-pill/projection';
	import { webPillLevel } from '$lib/recording-pill/web-level.svelte';
	import { dictationLifecycle } from '$lib/state/dictation-lifecycle.svelte';

	const status = $derived(projectLifecycleToStatus(dictationLifecycle.current));
</script>

{#if status}
	<!-- Bottom-center, matching the desktop overlay's resting position. -->
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
