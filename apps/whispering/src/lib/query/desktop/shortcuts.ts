import { type Command, commandCallbacks } from '$lib/commands';
import { IS_MACOS } from '$lib/constants/platform';
import { defineMutation } from '$lib/query/client';
import { desktopServices } from '$lib/services/desktop';
import type { Accelerator } from '$lib/services/desktop/global-shortcut-manager';
import { deviceConfig } from '$lib/state/device-config.svelte';

/**
 * Global shortcuts - desktop-only, require Tauri.
 * These use system-level global shortcuts that work even when the app is not focused.
 */
export const globalShortcuts = {
	registerCommand: defineMutation({
		mutationKey: ['shortcuts', 'registerCommandGlobally'] as const,
		mutationFn: ({
			command,
			// Parameter renamed to indicate it may contain legacy "CommandOrControl" syntax
			// Legacy format: "CommandOrControl+Shift+R" → Modern format: "Command+Shift+R" (macOS) or "Control+Shift+R" (Windows/Linux)
			accelerator: legacyAcceleratorString,
		}: {
			command: Command;
			accelerator: Accelerator;
		}) => {
			// Convert legacy "CommandOrControl" syntax to platform-specific modifiers for backwards compatibility
			// This ensures users with old settings don't need to manually update their shortcuts
			const accelerator = legacyAcceleratorString.replace(
				'CommandOrControl',
				IS_MACOS ? 'Command' : 'Control',
			) as Accelerator;
			const passthrough = deviceConfig.get('shortcuts.global.passthrough');
			return desktopServices.globalShortcutManager.register({
				accelerator,
				callback: commandCallbacks[command.id],
				on: command.on,
				passthrough,
			});
		},
	}),

	unregisterCommand: defineMutation({
		mutationKey: ['shortcuts', 'unregisterCommandGlobally'] as const,
		mutationFn: async ({ accelerator }: { accelerator: Accelerator }) => {
			return await desktopServices.globalShortcutManager.unregister(
				accelerator,
			);
		},
	}),

	unregisterAll: defineMutation({
		mutationKey: ['shortcuts', 'unregisterAllGlobalShortcuts'] as const,
		mutationFn: async () =>
			desktopServices.globalShortcutManager.unregisterAll(),
	}),
};
