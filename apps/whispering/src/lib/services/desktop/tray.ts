import { invoke } from '@tauri-apps/api/core';
import { Menu, MenuItem } from '@tauri-apps/api/menu';
import { resolveResource } from '@tauri-apps/api/path';
import { TrayIcon } from '@tauri-apps/api/tray';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { createTaggedError, extractErrorMessage } from 'wellcrafted/error';
// import { commandCallbacks } from '$lib/commands';
import { tryAsync } from 'wellcrafted/result';
import { goto } from '$app/navigation';
// import { extension } from '@epicenter/extension';
import type { WhisperingRecordingState } from '$lib/constants/audio';

const TRAY_ID = 'whispering-tray';

const { SetTrayIconServiceErr } = createTaggedError('SetTrayIconServiceError');

export function createTrayIconDesktopService() {
	const trayPromise = initTray().catch((error) => {
		console.error('Failed to initialize tray icon:', error);
		throw error;
	});
	return {
		setTrayIcon: (recorderState: WhisperingRecordingState) =>
			tryAsync({
				try: async () => {
					const iconPath = await getIconPath(recorderState);
					const tray = await trayPromise;
					return tray.setIcon(iconPath);
				},
				catch: (error) =>
					SetTrayIconServiceErr({
						message: `Failed to set tray icon: ${extractErrorMessage(error)}`,
					}),
			}),
	};
}

async function initTray() {
	const existingTray = await TrayIcon.getById(TRAY_ID);
	if (existingTray) return existingTray;

	const trayMenu = await Menu.new({
		items: [
			await MenuItem.new({
				id: 'settings',
				text: 'Settings',
				action: async () => {
					goto('/settings');
					const win = getCurrentWindow();
					await win.show();
					await win.setFocus();
				},
			}),

			await MenuItem.new({
				id: 'quit',
				text: 'Quit',
				// Uses a dedicated Rust command instead of the process plugin's
				// generic exit() — that gets treated the same as a window close
				// (hidden, not quit) whenever "menu bar only" is active.
				action: () => invoke('quit_app'),
			}),
		],
	});

	const tray = await TrayIcon.new({
		id: TRAY_ID,
		icon: await getIconPath('IDLE'),
		menu: trayMenu,
		// Show the menu (Settings, Quit) on a normal click, not just
		// right-click. Previously this was false with no click action wired
		// up at all (the click handler was commented out), so clicking the
		// tray icon did nothing.
		menuOnLeftClick: true,
	});

	return tray;
}

export type TrayIconService = ReturnType<typeof createTrayIconDesktopService>;

export const TrayIconServiceLive = createTrayIconDesktopService();

async function getIconPath(recorderState: WhisperingRecordingState) {
	const iconPaths = {
		IDLE: 'recorder-state-icons/studio_microphone.png',
		RECORDING: 'recorder-state-icons/red_large_square.png',
	} as const satisfies Record<WhisperingRecordingState, string>;
	return await resolveResource(iconPaths[recorderState]);
}
