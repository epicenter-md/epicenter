import type { Component } from 'svelte';

/**
 * What a `RecordingActionCard` needs from a recorder: its live state, the
 * presentation derived from that state, and a single toggle. Both
 * `createManualRecordingController` and `createVadRecordingController` satisfy
 * this structurally, so the card takes one `controller` prop instead of the
 * same eight-prop mapping spelled out at every call site.
 *
 * This is a shared contract (two factories implement it), so it is declared
 * explicitly here rather than derived from either factory's return type.
 */
export type RecordingActionController = {
	/** Capturing right now: drives the card's destructive "filled" treatment. */
	readonly active: boolean;
	/** Mid start or stop: drives the card's spinner. */
	readonly pending: boolean;
	readonly icon: Component<{ class?: string }>;
	readonly label: string;
	readonly description: string;
	readonly tooltip: string;
	readonly shortcutLabel: string;
	/** Start when idle, stop when active. */
	toggle(): void;
};
