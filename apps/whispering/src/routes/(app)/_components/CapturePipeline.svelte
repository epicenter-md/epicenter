<script lang="ts">
	import {
		TranscriptionSelector,
		TransformationSelector,
	} from '$lib/components/settings';
	import { settings } from '$lib/state/settings.svelte';
	import { viewTransition } from '$lib/utils/viewTransitions';
	import type { Snippet } from 'svelte';
	import CaptureBehaviorPopover from './CaptureBehaviorPopover.svelte';

	// The capture controls row. A live surface hands in its input-device selector
	// as children (manual vs VAD is the only difference); the pipeline adds the
	// universal model and transformation, plus the capture-behavior popover. Import
	// passes no children, so it shows just the model and transformation. Device and
	// behavior are the live-recording extras, so both hinge on the device children.
	let { children }: { children?: Snippet } = $props();

	// The selected transformation's pipeline glyph morphs into that
	// transformation's row on /transformations, so name it with the same id the
	// row carries.
	const transformationViewTransitionName = $derived(
		viewTransition.transformation(
			settings.get('transformation.selectedId') ?? null,
		),
	);
</script>

<div
	class="flex w-full items-center gap-1.5"
	role="group"
	aria-label="Capture pipeline"
>
	{#if children}
		{@render children()}
	{/if}
	<TranscriptionSelector
		variant="pipeline"
		iconViewTransitionName={viewTransition.pipeline.transcription}
	/>
	<TransformationSelector
		iconViewTransitionName={transformationViewTransitionName}
	/>
	{#if children}
		<CaptureBehaviorPopover />
	{/if}
</div>
