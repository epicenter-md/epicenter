import { os } from '#platform/os';
import { systemShortcuts } from '#platform/system-shortcuts';
import type { Command } from '$lib/commands';
import { focusedShortcuts } from '$lib/platform/focused-shortcuts';
import type { Shortcuts } from '$lib/platform/types';
import { keyBindingToLabel } from '$lib/utils/key-binding';

/**
 * The backend the one-label helper reads: the system (global) key leads on desktop
 * because it fires from anywhere; web has only the focused backend.
 */
const primaryShortcuts = systemShortcuts ?? focusedShortcuts;

/**
 * Preference order for the shortcut that starts each recording mode: the first
 * command with a binding live on this platform wins.
 *
 * Manual recording has two start commands. Push-to-talk is a held chord and
 * ships unbound, so it is opt-in. Toggle recording ships bound (Space in-app, a
 * chord globally), so its key shows by default. Push-to-talk still leads the
 * list, so once the user binds it that hold is what we show. VAD has a single
 * command, so its list has one entry.
 */
const RECORDING_SHORTCUT_PREFERENCE = {
	manual: ['pushToTalk', 'toggleManualRecording'],
	vad: ['toggleVadRecording'],
} as const satisfies Record<string, readonly Command['id'][]>;

export type RecordingShortcutMode = keyof typeof RECORDING_SHORTCUT_PREFERENCE;

/**
 * The label for the bound gesture this mode starts in one store, picked by walking
 * the preference list (the first bound command wins). Reading a single command
 * (`toggleManualRecording`) rendered an empty key when a user cleared the toggle
 * while another gesture was live; the list shows the bound gesture instead.
 * Returns `''` when nothing in the list is bound. `keyBindingToLabel` formats the
 * physical binding.
 */
function shortcutLabelFor(
	store: Shortcuts,
	mode: RecordingShortcutMode,
): string {
	for (const commandId of RECORDING_SHORTCUT_PREFERENCE[mode]) {
		const binding = store.current(commandId);
		if (binding) return keyBindingToLabel(binding, os.isApple);
	}
	return '';
}

/**
 * The single label that starts this recording mode on this platform, from the
 * primary backend. Callers that only need to know whether *a* shortcut exists
 * (the recording controllers) read this; the home hint reads both slots through
 * {@link getRecordingShortcutLabels}.
 */
export function getRecordingShortcutLabel(mode: RecordingShortcutMode): string {
	return shortcutLabelFor(primaryShortcuts, mode);
}

/**
 * Both reach slots for this recording mode: the in-app (`focused`) key and the
 * system-global (`global`) key. `focused` is `''` when unbound. `global` is `null`
 * when this platform has no system backend (web), and `''` when it has one but the
 * slot is unbound (desktop): one source of truth for "is there a global backend at
 * all" versus "there is, but it needs setting up". The home hint teaches both, so
 * a desktop user learns the quick in-app key *and* the from-anywhere gesture
 * (and, for VAD, the in-app key the single-label hint never surfaced, since VAD
 * ships no global default).
 *
 * This is the read-only badge philosophy of ADR-0052 applied to the home screen:
 * the user still expresses reach only by choosing a key, and the hint reflects
 * what each key's reach turned out to be. It is not a scope chooser.
 */
export function getRecordingShortcutLabels(mode: RecordingShortcutMode): {
	focused: string;
	global: string | null;
} {
	return {
		focused: shortcutLabelFor(focusedShortcuts, mode),
		global: systemShortcuts ? shortcutLabelFor(systemShortcuts, mode) : null,
	};
}
