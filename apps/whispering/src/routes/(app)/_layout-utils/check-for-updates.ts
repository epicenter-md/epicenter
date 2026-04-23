import { check, type DownloadEvent } from '@tauri-apps/plugin-updater';
import { extractErrorMessage } from 'wellcrafted/error';
import { tryAsync } from 'wellcrafted/result';
import {
	type UpdateInfo,
	updateDialog,
} from '$lib/components/UpdateDialog.svelte';
import { rpc } from '$lib/query';
import { WhisperingErr } from '$lib/result';

export async function checkForUpdates() {
	const { error } = await tryAsync({
		try: async () => {
			const update = await (shouldUseMockUpdates() ? mockCheck() : check());
			if (update) {
				await rpc.notify.info({
					title: `Update ${update.version} available`,
					description: 'A new version of Whispering is available.',
					action: {
						type: 'button',
						label: 'View Update',
						onClick: () => updateDialog.open(update),
					},
					persist: true,
				});
			}
		},
		catch: (error) =>
			WhisperingErr({
				title: 'Failed to check for updates',
				description: extractErrorMessage(error),
			}),
	});
	if (error) rpc.notify.error(error);
}

/**
 * Mock update check for testing the auto-update functionality.
 *
 * This mock simulates the behavior of the Tauri updater plugin's check() function,
 * allowing you to test the update UI flow without needing an actual update server.
 *
 * @example
 * ```typescript
 * const update = await (shouldUseMock ? mockCheck() : check());
 * ```
 *
 * @returns A mock Update object that simulates a real update with:
 * - Version 2.0.0 available
 * - Realistic download progress simulation (50MB over 5 seconds)
 * - Sample release notes in markdown format
 */
async function mockCheck(): Promise<UpdateInfo> {
	// Simulate network delay for realism
	await new Promise((resolve) => setTimeout(resolve, 1000));

	// Optionally return null to test "no update available" scenario
	// Uncomment the line below to test this case:
	// return null;

	// Return mock update data that matches the real release notes format
	return {
		version: '2.0.0',
		date: new Date().toISOString(),
		body: `This release adds automatic update checking on app startup and improves performance by 50% through optimized audio processing. We also added new dark mode theme options with better contrast.

## Automatic Updates

Whispering now checks for updates on startup and shows you what's new before installing. No more manually checking GitHub for new versions.

## Performance Improvements

Audio processing is now 50% faster thanks to optimized buffering and parallel processing. You should notice faster transcription times, especially for longer recordings.

## What's Changed

### Features
* feat: add automatic update checking on app startup by @braden-w in https://github.com/EpicenterHQ/epicenter/pull/1234
* feat: improve audio processing performance by @braden-w in https://github.com/EpicenterHQ/epicenter/pull/1235

### Bug Fixes
* fix: resolve memory leak in long recording sessions by @braden-w in https://github.com/EpicenterHQ/epicenter/pull/1236

**Full Changelog**: https://github.com/EpicenterHQ/epicenter/compare/v1.9.0...v2.0.0`,
		/**
		 * Mock download and install function that simulates real update behavior
		 */
		downloadAndInstall: async (
			progressCallback?: (event: DownloadEvent) => void,
		) => {
			// Simulate download progress
			const totalSize = 50 * 1024 * 1024; // 50MB
			let _downloaded = 0;

			// Emit Started event
			progressCallback?.({
				event: 'Started',
				data: { contentLength: totalSize },
			});

			// Simulate download in chunks
			for (let i = 0; i < 10; i++) {
				// Check if we should simulate an error (uncomment to test error handling)
				// if (i === 5) throw new Error('Network connection lost');

				await new Promise((resolve) => setTimeout(resolve, 500));
				const chunkSize = totalSize / 10;
				_downloaded += chunkSize;

				progressCallback?.({
					event: 'Progress',
					data: { chunkLength: chunkSize },
				});
			}

			// Emit Finished event
			progressCallback?.({ event: 'Finished' });
		},
	};
}

/**
 * Determines whether to use mock updates based on environment.
 *
 * @returns true if mock updates should be used, false otherwise
 */
function shouldUseMockUpdates(): boolean {
	return import.meta.env.DEV;
}
