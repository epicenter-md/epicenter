import { extractErrorMessage } from 'wellcrafted/error';
import { Err, partitionResults, tryAsync } from 'wellcrafted/result';
import { tauri } from '#platform/tauri';
import { goto } from '$app/navigation';
import { type Command, commandCallbacks, commands } from '$lib/commands';
import type { KeyboardEventSupportedKey } from '$lib/constants/keyboard';
import { report } from '$lib/report';
import { services } from '$lib/services';
import {
	type CommandId,
	shortcutStringToArray,
} from '$lib/services/local-shortcut-manager';
import { deviceConfig } from '$lib/state/device-config.svelte';
import { settings } from '$lib/state/settings.svelte';
import type { CommandBinding, KeyBinding } from '$lib/tauri/commands';

/**
 * Local shortcuts - cross-platform, work in web and desktop.
 * These use browser keyboard events.
 */
export const localShortcuts = {
	registerCommand: ({
		command,
		keyCombination,
	}: {
		command: Command;
		keyCombination: KeyboardEventSupportedKey[];
	}) =>
		services.localShortcutManager.register({
			id: command.id as CommandId,
			keyCombination,
			callback: commandCallbacks[command.id],
			on: command.on,
		}),

	unregisterCommand: async ({ commandId }: { commandId: CommandId }) =>
		services.localShortcutManager.unregister(commandId),
};

/** Canonical string for a binding, so structurally-equal bindings dedupe. */
function bindingKey(binding: {
	modifiers: readonly string[];
	keys: readonly string[];
}): string {
	return JSON.stringify({
		modifiers: [...binding.modifiers].sort(),
		keys: [...binding.keys].sort(),
	});
}

type LocalShortcutKey = `shortcut.${Command['id']}`;
type GlobalShortcutKey = `shortcuts.global.${Command['id']}`;

function getLocalShortcutKey(commandId: Command['id']): LocalShortcutKey {
	return `shortcut.${commandId}`;
}

function getGlobalShortcutKey(commandId: Command['id']): GlobalShortcutKey {
	return `shortcuts.global.${commandId}`;
}

/**
 * Synchronizes local keyboard shortcuts with the current settings.
 * - Registers shortcuts that have key combinations defined in settings
 * - Unregisters shortcuts that don't have key combinations defined
 * - Shows error toast if any registration/unregistration fails
 */
export async function syncLocalShortcutsWithSettings() {
	const results = await Promise.all(
		commands
			.map((command) => {
				const keyCombination = settings.get(getLocalShortcutKey(command.id));
				if (!keyCombination) {
					return localShortcuts.unregisterCommand({
						commandId: command.id as CommandId,
					});
				}
				return localShortcuts.registerCommand({
					command,
					keyCombination: shortcutStringToArray(String(keyCombination)),
				});
			})
			.filter((result) => result !== undefined),
	);
	const { errs } = partitionResults(results);
	if (errs.length > 0) {
		report.error({
			title: 'Error registering local commands',
			cause: {
				name: 'LocalShortcutRegistrationFailed',
				message: errs.map((err) => err.error.message).join('\n'),
			},
		});
	}
}

/**
 * Pushes the configured global shortcuts to the desktop rdev backend as the
 * full replace-all set. Storage holds structured `KeyBinding`s (physical-key
 * space), so they go straight through with no parsing.
 */
export async function syncGlobalShortcutsWithSettings() {
	if (!tauri) return;
	const { globalShortcuts } = tauri;

	const bindings: CommandBinding[] = [];
	for (const command of commands) {
		const binding = deviceConfig.get(getGlobalShortcutKey(command.id));
		if (!binding) continue;
		// Storage validates keys as plain strings; Rust validates them by name on
		// register. The cast bridges the stored `string[]` to the IPC `Key[]`.
		bindings.push({ commandId: command.id, binding: binding as KeyBinding });
	}

	// Keys are stored as plain strings and validated by Rust at the IPC boundary,
	// so a single bad key fails the whole replace-all call. Surface it instead of
	// letting every global shortcut silently go unregistered.
	const { error } = await tryAsync({
		try: () => globalShortcuts.setBindings(bindings),
		catch: (cause) =>
			Err({
				name: 'GlobalShortcutRegistrationFailed',
				message: extractErrorMessage(cause),
			}),
	});
	if (error) {
		report.error({ title: 'Error registering global shortcuts', cause: error });
	}
}

/**
 * Checks if any local shortcuts are duplicated and resets all to defaults if duplicates found.
 * Returns true if duplicates were found and reset, false otherwise.
 */
export function resetLocalShortcutsToDefaultIfDuplicates(): boolean {
	const seen = new Map<string, string>();

	// Check for duplicates
	for (const command of commands) {
		const shortcut = settings.get(getLocalShortcutKey(command.id));
		if (shortcut) {
			if (seen.has(String(shortcut))) {
				// If duplicates found, reset all local shortcuts to defaults
				resetLocalShortcuts();
				report.success({
					title: 'Shortcuts reset',
					description:
						'Duplicate local shortcuts detected. All local shortcuts have been reset to defaults.',
					action: {
						label: 'Configure shortcuts',
						onClick: () => goto('/settings/shortcuts'),
					},
				});

				return true;
			}
			seen.set(String(shortcut), command.id);
		}
	}
	return false;
}

/**
 * Checks if any global shortcuts are duplicated and resets all to defaults if duplicates found.
 * Returns true if duplicates were found and reset, false otherwise.
 */
export function resetGlobalShortcutsToDefaultIfDuplicates(): boolean {
	const seen = new Map<string, string>();

	// Check for duplicates by canonical binding string.
	for (const command of commands) {
		const binding = deviceConfig.get(getGlobalShortcutKey(command.id));
		if (!binding) continue;
		const key = bindingKey(binding);
		if (seen.has(key)) {
			// If duplicates found, reset all global shortcuts to defaults
			resetGlobalShortcuts();
			report.success({
				title: 'Shortcuts reset',
				description:
					'Duplicate global shortcuts detected. All global shortcuts have been reset to defaults.',
				action: {
					label: 'Configure shortcuts',
					onClick: () => goto('/settings/shortcuts'),
				},
			});

			return true;
		}
		seen.set(key, command.id);
	}
	return false;
}

/**
 * Reset all local shortcuts to their schema defaults and re-sync. Defaults come
 * from the synced workspace definition (`settings.getDefault`), the same source
 * the settings UI shows, so there is no parallel defaults map to drift.
 */
export function resetLocalShortcuts() {
	for (const command of commands) {
		const key = getLocalShortcutKey(command.id);
		settings.set(key, settings.getDefault(key));
	}
	void syncLocalShortcutsWithSettings();
}

/**
 * Reset all global shortcuts to their schema defaults and re-sync. Defaults come
 * from the device-config definition (`deviceConfig.getDefault`), the same source
 * the settings UI shows.
 */
export function resetGlobalShortcuts() {
	for (const command of commands) {
		const key = getGlobalShortcutKey(command.id);
		deviceConfig.set(key, deviceConfig.getDefault(key));
	}
	void syncGlobalShortcutsWithSettings();
}
