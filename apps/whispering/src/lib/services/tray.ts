import { Menu, MenuItem } from '@tauri-apps/api/menu';
import { resolveResource } from '@tauri-apps/api/path';
import { TrayIcon } from '@tauri-apps/api/tray';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { exit } from '@tauri-apps/plugin-process';
import { createTaggedError } from 'wellcrafted/error';
// import { commandCallbacks } from '$lib/commands';
import { type Err, Ok, tryAsync } from 'wellcrafted/result';
import { goto } from '$app/navigation';
// import { extension } from '@repo/extension';
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
};

export function createTrayIconWebService(): SetTrayIconService {
	return {
		setTrayIcon: async (icon: WhisperingRecordingState) => {
			// const { error: setRecorderStateError } = await extension.setRecorderState(
			// 	{ recorderState: icon },
			// );
			// if (setRecorderStateError)
			// 	return SetTrayIconServiceErr({
			// 		message: 'Failed to set recorder state',
			// 		context: { icon },
			// 		cause: setRecorderStateError,
			// 	});
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
					return tray.setIcon(iconPath);
				},
				catch: (error) =>
					SetTrayIconServiceErr({
						message: 'Failed to set tray icon',
						context: { icon: recorderState },
						cause: error,
					}),
			}),
	};
}

async function initTray() {
	const existingTray = await TrayIcon.getById(TRAY_ID);
	if (existingTray) return existingTray;

	const trayMenu = await Menu.new({
		items: [
			// Window Controls Section
			await MenuItem.new({
				id: 'show',
				text: 'Show Window',
				action: () => getCurrentWindow().show(),
			}),

			await MenuItem.new({
				id: 'hide',
				text: 'Hide Window',
				action: () => getCurrentWindow().hide(),
			}),

			// Settings Section
			await MenuItem.new({
				id: 'settings',
				text: 'Settings',
				action: () => {
					goto('/settings');
					return getCurrentWindow().show();
				},
			}),

			// Quit Section
			await MenuItem.new({
				id: 'quit',
				text: 'Quit',
				action: () => void exit(0),
			}),
		],
	});

	const tray = await TrayIcon.new({
		id: TRAY_ID,
		icon: await getIconPath('IDLE'),
		menu: trayMenu,
		menuOnLeftClick: false,
		action: (e) => {
			if (
				e.type === 'Click' &&
				e.button === 'Left' &&
				e.buttonState === 'Down'
			) {
				// commandCallbacks.toggleManualRecording();
				return true;
			}
			return false;
		},
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

export const TrayIconServiceLive = window.__TAURI_INTERNALS__
	? createTrayIconDesktopService()
	: createTrayIconWebService();
