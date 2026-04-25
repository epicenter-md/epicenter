import { describe, expect, it, mock } from 'bun:test';

// Mocks must be defined before the module under test is loaded
mock.module('$app/environment', () => ({
	browser: true,
	dev: true,
}));

// Mock deviceConfig
const mockDeviceConfig = {
	get: mock((key: string) => {
		if (key === 'shortcuts.global.passthrough') {
			return true;
		}
		return false;
	}),
	set: mock(() => {}),
};

// Mock desktopServices
const mockGlobalShortcutManager = {
	register: mock(() => Promise.resolve({ data: undefined })),
};

const mockDesktopServices = {
	globalShortcutManager: mockGlobalShortcutManager,
};

// Mock commandCallbacks
const mockCommandCallbacks = {
	toggleManualRecording: () => {},
};

mock.module('$lib/state/device-config.svelte', () => ({
	deviceConfig: mockDeviceConfig,
}));

mock.module('$lib/services/desktop', () => ({
	desktopServices: mockDesktopServices,
}));

mock.module('$lib/commands', () => ({
	commandCallbacks: mockCommandCallbacks,
}));

mock.module('$lib/constants/platform', () => ({
	IS_MACOS: false,
}));

// Now load the module under test
const { globalShortcuts } = require('./shortcuts.ts');

describe('globalShortcuts', () => {
	describe('registerCommand', () => {
		it('should use the global passthrough setting when registering a command', async () => {
			const command = {
				id: 'toggleManualRecording',
				title: 'Toggle Manual Recording',
				on: ['Pressed'],
			} as any;

			await globalShortcuts.registerCommand({
				command,
				accelerator: 'Control+Shift+;' as any,
			});

			expect(mockDeviceConfig.get).toHaveBeenCalledWith('shortcuts.global.passthrough');
			expect(mockGlobalShortcutManager.register).toHaveBeenCalledWith(
				expect.objectContaining({
					passthrough: true,
				}),
			);
		});

		it('should respect false value for global passthrough', async () => {
			mockDeviceConfig.get.mockImplementation((key: string) => {
				if (key === 'shortcuts.global.passthrough') {
					return false;
				}
				return true;
			});

			const command = {
				id: 'toggleManualRecording',
				title: 'Toggle Manual Recording',
				on: ['Pressed'],
			} as any;

			await globalShortcuts.registerCommand({
				command,
				accelerator: 'Control+Shift+;' as any,
			});

			expect(mockGlobalShortcutManager.register).toHaveBeenCalledWith(
				expect.objectContaining({
					passthrough: false,
				}),
			);
		});
	});
});
