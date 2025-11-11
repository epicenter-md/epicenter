export const PATHS = {
	MODELS: {
		async WHISPER() {
			const { appDataDir, join } = await import('@tauri-apps/api/path');
			const dir = await appDataDir();
			return await join(dir, 'models', 'whisper');
		},
		async PARAKEET() {
			const { appDataDir, join } = await import('@tauri-apps/api/path');
			const dir = await appDataDir();
			return await join(dir, 'models', 'parakeet');
		},
	},
	DB: {
		async RECORDINGS() {
			const { appDataDir, join } = await import('@tauri-apps/api/path');
			const dir = await appDataDir();
			return await join(dir, 'recordings');
		},
		async TRANSFORMATIONS() {
			const { appDataDir, join } = await import('@tauri-apps/api/path');
			const dir = await appDataDir();
			return await join(dir, 'transformations');
		},
		async TRANSFORMATION_RUNS() {
			const { appDataDir, join } = await import('@tauri-apps/api/path');
			const dir = await appDataDir();
			return await join(dir, 'transformation-runs');
		},
	},
};
