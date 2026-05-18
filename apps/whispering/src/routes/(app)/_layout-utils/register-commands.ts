import { partitionResults } from 'wellcrafted/result';
import { commands } from '$lib/commands';
import { CommandOrAlt, CommandOrControl } from '$lib/constants/keyboard';
import { rpc } from '$lib/query';
import { desktopRpc } from '$lib/query/desktop';
import type { Accelerator } from '$lib/services/desktop/global-shortcut-manager';
import {
	type CommandId,
	shortcutStringToArray,
} from '$lib/services/local-shortcut-manager';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { settings } from '$lib/state/settings.svelte';

/**
 * Grandfather migration: users who were already on Whispering before the
 * local-subsystem toggle landed keep `shortcuts.local.enabled = true` so their
 * existing in-app shortcuts keep working. Fresh installs get the new default
 * (false).
 *
 * Detection: we treat the user as pre-existing if EITHER (a) the prior
 * monolithic-to-per-key migration has completed (`whispering.settings.migration
 * === 'completed'`) OR (b) the old monolithic `whispering-settings` blob is
 * still present (migration runs async and may not have completed yet by the
 * time we get here on first boot of the new build). Brand-new installs match
 * neither and stay OFF.
 *
 * Idempotent via its own marker so it only flips the setting once.
 */
const GRANDFATHER_MARKER_KEY = 'whispering.shortcuts.local.enabled.grandfathered';
const OLD_SETTINGS_MIGRATION_KEY = 'whispering.settings.migration';
const OLD_SETTINGS_BLOB_KEY = 'whispering-settings';

export function grandfatherLocalShortcutsEnabled() {
	if (window.localStorage.getItem(GRANDFATHER_MARKER_KEY) === 'done') return;
	const isExistingUser =
		window.localStorage.getItem(OLD_SETTINGS_MIGRATION_KEY) === 'completed' ||
		window.localStorage.getItem(OLD_SETTINGS_BLOB_KEY) !== null;
	if (isExistingUser) {
		settings.set('shortcuts.local.enabled', true);
	}
	window.localStorage.setItem(GRANDFATHER_MARKER_KEY, 'done');
}

/** Default values for in-app (local) shortcuts. Keyed by command id string. */
const DEFAULT_LOCAL_SHORTCUTS: Record<string, string | null> = {
	pushToTalk: 'p',
	toggleManualRecording: ' ',
	startManualRecording: null,
	stopManualRecording: null,
	cancelManualRecording: 'c',
	startVadRecording: null,
	stopVadRecording: null,
	toggleVadRecording: 'v',
	openTransformationPicker: 't',
	runTransformationOnClipboard: 'r',
};

/** Default values for global OS shortcuts. Keyed by command id string. */
const DEFAULT_GLOBAL_SHORTCUTS: Record<string, string | null> = {
	pushToTalk: `${CommandOrAlt}+Shift+D`,
	toggleManualRecording: `${CommandOrControl}+Shift+;`,
	startManualRecording: null,
	stopManualRecording: null,
	cancelManualRecording: `${CommandOrControl}+Shift+'`,
	startVadRecording: null,
	stopVadRecording: null,
	toggleVadRecording: null,
	openTransformationPicker: `${CommandOrControl}+Shift+X`,
	runTransformationOnClipboard: `${CommandOrControl}+Shift+R`,
};

type LocalShortcutKey =
	| 'shortcut.toggleManualRecording'
	| 'shortcut.startManualRecording'
	| 'shortcut.stopManualRecording'
	| 'shortcut.cancelManualRecording'
	| 'shortcut.toggleVadRecording'
	| 'shortcut.startVadRecording'
	| 'shortcut.stopVadRecording'
	| 'shortcut.pushToTalk'
	| 'shortcut.openTransformationPicker'
	| 'shortcut.runTransformationOnClipboard';

type GlobalShortcutKey =
	| 'shortcuts.global.toggleManualRecording'
	| 'shortcuts.global.startManualRecording'
	| 'shortcuts.global.stopManualRecording'
	| 'shortcuts.global.cancelManualRecording'
	| 'shortcuts.global.toggleVadRecording'
	| 'shortcuts.global.startVadRecording'
	| 'shortcuts.global.stopVadRecording'
	| 'shortcuts.global.pushToTalk'
	| 'shortcuts.global.openTransformationPicker'
	| 'shortcuts.global.runTransformationOnClipboard';

function getLocalShortcutKey(commandId: string): LocalShortcutKey {
	return `shortcut.${commandId}` as LocalShortcutKey;
}

function getGlobalShortcutKey(commandId: string): GlobalShortcutKey {
	return `shortcuts.global.${commandId}` as GlobalShortcutKey;
}

/**
 * Synchronizes local keyboard shortcuts with the current settings.
 * - Returns early if the local subsystem is disabled (the window listener in
 *   +layout.svelte is already gated on the same setting, so any registrations
 *   left in the in-memory Map are inert until the listener restarts)
 * - Registers shortcuts that have key combinations defined in settings
 * - Unregisters shortcuts that don't have key combinations defined
 * - Shows error toast if any registration/unregistration fails
 */
export async function syncLocalShortcutsWithSettings() {
	if (!settings.get('shortcuts.local.enabled')) return;
	const results = await Promise.all(
		commands
			.map((command) => {
				const keyCombination = settings.get(getLocalShortcutKey(command.id));
				if (!keyCombination) {
					return rpc.localShortcuts.unregisterCommand({
						commandId: command.id as CommandId,
					});
				}
				return rpc.localShortcuts.registerCommand({
					command,
					keyCombination: shortcutStringToArray(String(keyCombination)),
				});
			})
			.filter((result) => result !== undefined),
	);
	const { errs } = partitionResults(results);
	if (errs.length > 0) {
		rpc.notify.error({
			title: 'Error registering local commands',
			description: errs.map((err) => err.error.message).join('\n'),
			action: { type: 'more-details', error: errs },
		});
	}
}

/**
 * Synchronizes global keyboard shortcuts with the current settings.
 * - Tears down all OS-level registrations and returns early if the global
 *   subsystem is disabled (so disabling actually frees the hotkeys system-wide)
 * - Registers shortcuts that have key combinations defined in settings
 * - Unregisters shortcuts that don't have key combinations defined
 * - Shows error toast if any registration/unregistration fails
 */
export async function syncGlobalShortcutsWithSettings() {
	if (!settings.get('shortcuts.global.enabled')) {
		await desktopRpc.globalShortcuts.unregisterAll();
		return;
	}
	const commandsWithAccelerators = commands
		.map((command) => {
			const accelerator = deviceConfig.get(
				getGlobalShortcutKey(command.id),
			) as Accelerator | null;
			if (!accelerator) return null;
			return { command, accelerator };
		})
		.filter((item) => item !== null);

	const results = await Promise.all(
		commandsWithAccelerators.map((item) =>
			desktopRpc.globalShortcuts.registerCommand(item),
		),
	);
	const { errs } = partitionResults(results);
	if (errs.length > 0) {
		rpc.notify.error({
			title: 'Error registering global commands',
			description: errs.map((err) => err.error.message).join('\n'),
			action: { type: 'more-details', error: errs },
		});
	}
}

/**
 * Checks if any local shortcuts are duplicated and resets all to defaults if duplicates found.
 * Returns true if duplicates were found and reset, false otherwise.
 */
export function resetLocalShortcutsToDefaultIfDuplicates(): boolean {
	const localShortcuts = new Map<string, string>();

	// Check for duplicates
	for (const command of commands) {
		const shortcut = settings.get(getLocalShortcutKey(command.id));
		if (shortcut) {
			if (localShortcuts.has(String(shortcut))) {
				// If duplicates found, reset all local shortcuts to defaults
				resetLocalShortcuts();
				rpc.notify.success({
					title: 'Shortcuts reset',
					description:
						'Duplicate local shortcuts detected. All local shortcuts have been reset to defaults.',
					action: {
						type: 'link',
						label: 'Configure shortcuts',
						href: '/settings/shortcuts/local',
					},
				});

				return true;
			}
			localShortcuts.set(String(shortcut), command.id);
		}
	}
	return false;
}

/**
 * Checks if any global shortcuts are duplicated and resets all to defaults if duplicates found.
 * Returns true if duplicates were found and reset, false otherwise.
 */
export function resetGlobalShortcutsToDefaultIfDuplicates(): boolean {
	const globalShortcuts = new Map<string, string>();

	// Check for duplicates
	for (const command of commands) {
		const shortcut = deviceConfig.get(getGlobalShortcutKey(command.id));
		if (shortcut) {
			if (globalShortcuts.has(shortcut)) {
				// If duplicates found, reset all global shortcuts to defaults
				resetGlobalShortcuts();
				rpc.notify.success({
					title: 'Shortcuts reset',
					description:
						'Duplicate global shortcuts detected. All global shortcuts have been reset to defaults.',
					action: {
						type: 'link',
						label: 'Configure shortcuts',
						href: '/settings/shortcuts/global',
					},
				});

				return true;
			}
			globalShortcuts.set(shortcut, command.id);
		}
	}
	return false;
}

/**
 * Reset all local shortcuts to their default values and re-sync.
 */
export function resetLocalShortcuts() {
	for (const command of commands) {
		settings.set(
			getLocalShortcutKey(command.id),
			DEFAULT_LOCAL_SHORTCUTS[command.id] ?? null,
		);
	}
	void syncLocalShortcutsWithSettings();
}

/**
 * Reset all global shortcuts to their default values and re-sync.
 */
export function resetGlobalShortcuts() {
	for (const command of commands) {
		deviceConfig.set(
			getGlobalShortcutKey(command.id),
			DEFAULT_GLOBAL_SHORTCUTS[command.id] ?? null,
		);
	}
	void syncGlobalShortcutsWithSettings();
}
