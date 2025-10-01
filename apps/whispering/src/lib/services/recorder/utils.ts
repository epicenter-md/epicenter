/**
 * Get the default recordings folder for the current platform.
 * Returns the app data directory/recordings for desktop.
 */
export async function getDefaultRecordingsFolder() {
	const { appDataDir, join } = await import('@tauri-apps/api/path');
	// In desktop, use the app data directory as default
	return await join(await appDataDir(), 'recordings');
}
