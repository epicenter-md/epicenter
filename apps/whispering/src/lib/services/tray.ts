import { Menu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';
import { resolveResource } from '@tauri-apps/api/path';
import { TrayIcon } from '@tauri-apps/api/tray';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { exit } from '@tauri-apps/plugin-process';
import { createTaggedError } from 'wellcrafted/error';
import { type Err, Ok, tryAsync } from 'wellcrafted/result';
import { goto } from '$app/navigation';
import { commandCallbacks } from '$lib/commands';
import type { WhisperingRecordingState } from '$lib/constants/audio';

const TRAY_ID = 'whispering-tray';

const { SetTrayIconServiceError, SetTrayIconServiceErr } = createTaggedError(
	'SetTrayIconServiceError',
);
type SetTrayIconServiceError = ReturnType<typeof SetTrayIconServiceError>;

type SetTrayIconService = {
	setTrayIcon: (
		icon: WhisperingRecordingState,
	) => Promise<Ok<void> | Err<SetTrayIconServiceError>>;
	updateMenu: (
		recorderState: WhisperingRecordingState,
	) => Promise<Ok<void> | Err<SetTrayIconServiceError>>;
};

export function createTrayIconWebService(): SetTrayIconService {
	return {
		setTrayIcon: async (icon: WhisperingRecordingState) => {
			return Ok(undefined);
		},
		updateMenu: async (recorderState: WhisperingRecordingState) => {
			return Ok(undefined);
		},
	};
}

export function createTrayIconDesktopService(): SetTrayIconService {
	const trayPromise = initTray();

	return {
		setTrayIcon: (recorderState: WhisperingRecordingState) =>
			tryAsync({
				try: async () => {
					const iconPath = await getIconPath(recorderState);
					const tray = await trayPromise;
					await tray.setIcon(iconPath);
					// Update menu when icon changes
					const menu = await createTrayMenu(recorderState);
					await tray.setMenu(menu);
				},
				catch: (error) =>
					SetTrayIconServiceErr({
						message: 'Failed to set tray icon',
						context: { icon: recorderState },
						cause: error,
					}),
			}),
		updateMenu: (recorderState: WhisperingRecordingState) =>
			tryAsync({
				try: async () => {
					const tray = await trayPromise;
					const menu = await createTrayMenu(recorderState);
					await tray.setMenu(menu);
				},
				catch: (error) =>
					SetTrayIconServiceErr({
						message: 'Failed to update tray menu',
						context: { icon: recorderState },
						cause: error,
					}),
			}),
	};
}

async function createTrayMenu(recorderState: WhisperingRecordingState) {
	const items = [];

	// Recording Controls Section
	if (recorderState === 'RECORDING') {
		items.push(
			await MenuItem.new({
				id: 'stop-recording',
				text: 'Stop Recording',
				action: () => commandCallbacks.stopManualRecording(),
			}),
		);
		items.push(
			await MenuItem.new({
				id: 'view-recording',
				text: 'View Recording',
				action: () => {
					goto('/');
					return getCurrentWindow().show();
				},
			}),
		);
		items.push(await PredefinedMenuItem.new({ item: 'Separator' }));
	} else {
		items.push(
			await MenuItem.new({
				id: 'start-recording',
				text: 'Start Recording',
				action: () => commandCallbacks.startManualRecording(),
			}),
		);
		items.push(await PredefinedMenuItem.new({ item: 'Separator' }));
	}

	// Window Controls Section
	items.push(
		await MenuItem.new({
			id: 'show',
			text: 'Show Window',
			action: () => getCurrentWindow().show(),
		}),
	);
	items.push(
		await MenuItem.new({
			id: 'hide',
			text: 'Hide Window',
			action: () => getCurrentWindow().hide(),
		}),
	);
	items.push(await PredefinedMenuItem.new({ item: 'Separator' }));

	// Settings Section
	items.push(
		await MenuItem.new({
			id: 'settings',
			text: 'Settings',
			action: () => {
				goto('/settings');
				return getCurrentWindow().show();
			},
		}),
	);
	items.push(await PredefinedMenuItem.new({ item: 'Separator' }));

	// Quit Section
	items.push(
		await MenuItem.new({
			id: 'quit',
			text: 'Quit',
			action: () => void exit(0),
		}),
	);

	return Menu.new({ items });
}

async function initTray() {
	const existingTray = await TrayIcon.getById(TRAY_ID);
	if (existingTray) {
		return existingTray;
	}

	const trayMenu = await createTrayMenu('IDLE');
	const iconPath = await getIconPath('IDLE');

	const tray = await TrayIcon.new({
		id: TRAY_ID,
		icon: iconPath,
		menu: trayMenu,
		menuOnLeftClick: true,
	});

	return tray;
}

async function getIconPath(recorderState: WhisperingRecordingState) {
	const iconPaths = {
		IDLE: 'recorder-state-icons/studio_microphone.png',
		RECORDING: 'recorder-state-icons/red_large_square.png',
	} as const satisfies Record<WhisperingRecordingState, string>;
	return await resolveResource(iconPaths[recorderState]);
}

export const TrayIconServiceLive = {
	setTrayIcon: async (icon: WhisperingRecordingState) => {
		if (window.__TAURI_INTERNALS__) {
			if (!desktopServiceInstance) {
				desktopServiceInstance = createTrayIconDesktopService();
			}
			return await desktopServiceInstance.setTrayIcon(icon);
		} else {
			if (!webServiceInstance) {
				webServiceInstance = createTrayIconWebService();
			}
			return await webServiceInstance.setTrayIcon(icon);
		}
	},
	updateMenu: async (recorderState: WhisperingRecordingState) => {
		if (window.__TAURI_INTERNALS__) {
			if (!desktopServiceInstance) {
				desktopServiceInstance = createTrayIconDesktopService();
			}
			return await desktopServiceInstance.updateMenu(recorderState);
		} else {
			if (!webServiceInstance) {
				webServiceInstance = createTrayIconWebService();
			}
			return await webServiceInstance.updateMenu(recorderState);
		}
	},
};

let desktopServiceInstance: SetTrayIconService | null = null;
let webServiceInstance: SetTrayIconService | null = null;
