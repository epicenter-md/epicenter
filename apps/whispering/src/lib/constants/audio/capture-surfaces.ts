/**
 * A capture surface is one of the three ways to start a transcription from the
 * home page or the config header: the two microphone triggers (`manual`, `vad`)
 * plus `import` (file import, shown to the user as "Upload File").
 *
 * `manual` and `vad` mirror the durable `recordingTrigger` setting (they have a
 * device, a shortcut, an overlay, and live capture). `import` is deliberately
 * NOT a trigger: it has none of those, so it never persists and never writes
 * `recordingTrigger`. It's a transient presentational overlay, owned by
 * `capture-surface.svelte.ts`. Modeling it only here, layered on top of the
 * triggers, restores the old three-way UI choice without re-conflating import
 * back into the trigger setting (the split made in `17dbd3c14`).
 */

import FileUpIcon from '@lucide/svelte/icons/file-up';
import type { Component } from 'svelte';
import { RECORDING_TRIGGER_META } from './recording-triggers';

export const CAPTURE_SURFACES = ['manual', 'vad', 'import'] as const;
export type CaptureSurface = (typeof CAPTURE_SURFACES)[number];

/**
 * Per-surface metadata. The two triggers reuse `RECORDING_TRIGGER_META`
 * verbatim, so a trigger is still described in exactly one place; only `import`
 * adds its own label and icon here.
 */
export const CAPTURE_SURFACE_META = {
	...RECORDING_TRIGGER_META,
	import: {
		label: 'Upload File',
		Icon: FileUpIcon,
	},
} as const satisfies Record<
	CaptureSurface,
	{
		label: string;
		Icon: Component<{ class?: string }>;
	}
>;

/**
 * Render-ready surface list (value, label, lucide icon) in display order, for
 * the homepage tabs and the header dropdown.
 */
export const CAPTURE_SURFACE_OPTIONS = CAPTURE_SURFACES.map((value) => ({
	value,
	label: CAPTURE_SURFACE_META[value].label,
	Icon: CAPTURE_SURFACE_META[value].Icon,
}));
