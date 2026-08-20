/**
 * This device's Vocab settings, read from the DEVICE document's `kv`.
 *
 * Always the device document, signed in or out (ADR-0233): how this screen
 * renders is a fact about this screen, not portable work, so it does not follow
 * the account replica and does not travel between machines.
 *
 * `kv` rather than a settings row, because a KV root is addressed by its name.
 * A row at a chosen id let two devices each mint a container at that address on
 * their own boot paths, and map LWW then discarded one along with everything in
 * it (ADR-0213).
 */

import type { VocabRuntime } from '../runtime.js';

const APPLICATION_DEFAULTS = { showReadings: true } as const;

export function createSettingsState({
	deviceData,
}: {
	deviceData: VocabRuntime['deviceData'];
}) {
	function read(): boolean {
		const { data, error } = deviceData.kv.get();
		if (data !== null) return data.showReadings;
		// A declared key is never absent, so the only way here is a stored value
		// that no longer satisfies the workspace: the error arm is always that
		// diagnostic. Its surviving half over the application defaults is a whole
		// settings object, which is the recovery composition the KV handle
		// documents.
		const settings = { ...APPLICATION_DEFAULTS, ...error.conforming };
		return settings.showReadings === true;
	}

	let showReadings = $state.raw(read());
	// Registration is synchronous, does no I/O and never fires initially, so the
	// read above has already seen everything (ADR-0187).
	const stop = deviceData.kv.subscribe(() => {
		showReadings = read();
	});

	return {
		/** Whether pronunciation readings render over the tutor's text. */
		get showReadings() {
			return showReadings;
		},
		/** Flip it. A schema failure is reported by the next read, not this write. */
		toggleReadings(): void {
			deviceData.kv.update({ showReadings: !showReadings });
		},
		[Symbol.dispose]: stop,
	};
}
