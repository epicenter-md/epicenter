export const PATHS = {
	async whisperModelsDirectory() {
		const { appDataDir } = await import('@tauri-apps/api/path');
		const dir = await appDataDir();
		return dir ? `${dir}/whispering/models` : null;
	},
};
