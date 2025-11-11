import { partitionResults } from 'wellcrafted/result';
import { commands } from '$lib/commands';
import { rpc } from '$lib/query';
import type { Accelerator } from '$lib/services/global-shortcut-manager';
import {
	type CommandId,
	shortcutStringToArray,
} from '$lib/services/local-shortcut-manager';
import type { Settings } from '$lib/settings';
import { settings } from '$lib/stores/settings.svelte';

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
				const keyCombination = settings.value[`shortcuts.local.${command.id}`];
				if (!keyCombination) {
					return rpc.shortcuts.unregisterCommandLocally.execute({
						commandId: command.id as CommandId,
					});
				}
				return rpc.shortcuts.registerCommandLocally.execute({
					command,
					keyCombination: shortcutStringToArray(keyCombination),
				});
			})
			.filter((result) => result !== undefined),
	);
	const { errs } = partitionResults(results);
	if (errs.length > 0) {
		rpc.notify.error.execute({
			title: 'Error registering local commands',
			description: errs.map((err) => err.error.message).join('\n'),
			action: { type: 'more-details', error: errs },
		});
	}
}

/**
 * Synchronizes global keyboard shortcuts with the current settings.
 * - Registers shortcuts that have key combinations defined in settings
 * - Unregisters shortcuts that don't have key combinations defined
 * - Shows error toast if any registration/unregistration fails
 */
export async function syncGlobalShortcutsWithSettings() {
	const results = await Promise.all(
		commands
			.map((command) => {
				const accelerator = settings.value[
					`shortcuts.global.${command.id}`
				] as Accelerator | null;
				if (!accelerator) return;
				return rpc.shortcuts.registerCommandGlobally.execute({
					command,
					accelerator,
				});
			})
			.filter((result) => result !== undefined),
	);
	const { errs } = partitionResults(results);
	if (errs.length > 0) {
		rpc.notify.error.execute({
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
		const shortcut = settings.value[`shortcuts.local.${command.id}`];
		if (shortcut) {
			if (localShortcuts.has(shortcut)) {
				// If duplicates found, reset all local shortcuts to defaults
				settings.resetLocalShortcuts();
				rpc.notify.success.execute({
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
			localShortcuts.set(shortcut, command.id);
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
		const shortcut = settings.value[`shortcuts.global.${command.id}`];
		if (shortcut) {
			if (globalShortcuts.has(shortcut)) {
				// If duplicates found, reset all global shortcuts to defaults
				settings.resetGlobalShortcuts();
				rpc.notify.success.execute({
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
