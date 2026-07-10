import { tauri } from '#platform/tauri';
import type { DictationCapability } from '$lib/tauri/commands';

const OVERRIDABLE_DICTATION_CAPABILITIES = [
	'inactive',
	'untrusted',
	'active',
	'broken',
] as const satisfies readonly DictationCapability[];
type DictationCapabilityOverride =
	| (typeof OVERRIDABLE_DICTATION_CAPABILITIES)[number]
	| null;

/**
 * The frontend's view over the one OS-trust fact Rust owns: whether Whispering
 * can paste at the cursor when auto-paste is enabled. The Rust supervisor
 * computes the `DictationCapability` from the live macOS Accessibility trust.
 * This module does NOT probe the OS, infer liveness, or poll for grant changes:
 * it seeds the value once and then tracks the pushed event. The macOS notice and
 * the guide dialog both READ this single value.
 *
 * Off the desktop build there is no Rust tap and no gate, so `attach()` is a
 * no-op and the value stays `unknown`; the browser build handles shortcuts with
 * in-app keydown and never mounts the macOS surfaces.
 */
function createDictationCapability() {
	let status = $state<DictationCapability>('unknown');
	let detached = false;

	// Dev-only override to exercise the notice/guide on any build (including web
	// dev, where the real value is always `unknown`) without touching System
	// Settings. `null` means "use the live value". The `import.meta.env.DEV`
	// guard in `effective` makes this dead in production, so it can never ship a
	// bypass: the real value always wins.
	let override = $state<DictationCapabilityOverride>(null);

	/** The value callers see: the dev override when set, else the live value. */
	function effective(): DictationCapability {
		if (import.meta.env.DEV && override) return override;
		return status;
	}

	return {
		/** Accessibility is trusted: paste at cursor can work. */
		get isActive(): boolean {
			return effective() === 'active';
		},
		/**
		 * macOS needs an Accessibility action: either never granted (`untrusted`)
		 * or a stale post-update grant (`broken`). The two differ in remediation,
		 * so views switch on `status`; this is the "show the notice at all" gate.
		 */
		get needsAccessibility(): boolean {
			const s = effective();
			return s === 'untrusted' || s === 'broken';
		},
		/** A stale grant: the fix is remove-and-re-add, not "just toggle on". */
		get isStale(): boolean {
			return effective() === 'broken';
		},
		/**
		 * Dev-only: pin the capability (or `null` to resume the live value) so the
		 * denied/granted/stale UI can be toggled in real time. No-op in production
		 * via the guard in `effective`.
		 */
		get override(): DictationCapabilityOverride {
			return override;
		},
		cycleOverride() {
			// Step to the next pinnable capability; past the last one, `?? null`
			// wraps back to the live value. `null` seeds at -1 so it starts the walk.
			const index =
				override === null
					? -1
					: OVERRIDABLE_DICTATION_CAPABILITIES.indexOf(override);
			override = OVERRIDABLE_DICTATION_CAPABILITIES[index + 1] ?? null;
		},

		/**
		 * Seed the value from Rust and subscribe to changes. Returns a cleanup that
		 * removes the subscription. Call once from the desktop runtime owners. The
		 * seed is applied only while we are still `unknown`, so an event that lands
		 * before the seed resolves is never clobbered by the stale seed.
		 */
		attach(): () => void {
			if (!tauri) return () => {};
			detached = false;
			const t = tauri;
			let unlisten: (() => void) | undefined;
			void t.keyboard.getDictationCapability().then((capability) => {
				if (!detached && status === 'unknown') status = capability;
			});
			void t.keyboard
				.onDictationCapabilityChanged((capability) => {
					status = capability;
				})
				.then((fn) => {
					if (detached) fn();
					else unlisten = fn;
				});
			return () => {
				detached = true;
				unlisten?.();
			};
		},
	};
}

export const dictationCapability = createDictationCapability();
