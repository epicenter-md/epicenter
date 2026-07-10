<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Popover from '@epicenter/ui/popover';
	import SlidersHorizontalIcon from '@lucide/svelte/icons/sliders-horizontal';
	import OutputDeliveryControls from '$lib/components/OutputDeliveryControls.svelte';

	// Quick access to the per-session capture behaviors that otherwise live in
	// Settings. The trailing bookend of the capture pipeline row, matching the
	// device/model/polish popover grammar. Booleans only: pickers stay as
	// pills, set-and-forget config stays in Settings. This is the one surface that
	// curates a capture behavior (pause playback) next to the transcription output
	// delivery, and both reuse the same components the Settings page renders, so
	// there is one source of truth with no drift.
	let open = $state(false);

</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				tooltip="Quick settings"
				aria-label="Quick settings"
				aria-expanded={open}
				variant="ghost"
				size="icon"
			>
				<SlidersHorizontalIcon class="size-4" />
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-80">
		<div class="flex flex-col gap-3">
			<OutputDeliveryControls scope="transcription" />
		</div>
	</Popover.Content>
</Popover.Root>
