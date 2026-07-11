/**
 * Tauri path helpers for Whispering's appdata directories.
 *
 * Tauri derives this root from `appDataDir()`, i.e.
 * `${dataDir}/${bundleIdentifier}`. With identifier
 * `so.epicenter`, that means:
 *   macOS:   ~/Library/Application Support/so.epicenter/
 *   Windows: %APPDATA%/so.epicenter/
 *   Linux:   ~/.local/share/so.epicenter/
 *
 * This module stays importable from browser builds because routes statically
 * import it while guarding calls with `tauri`; the build-time platform seam
 * keeps the native path API out of the hosted bundle.
 */
import { tauri } from '#platform/tauri';

async function appDataPath(...segments: string[]) {
	if (!tauri)
		throw new Error('App data paths require the Epicenter desktop app');
	return tauri.fs.appDataPath(...segments);
}

export const PATHS = {
	/**
	 * Filesystem storage for recording audio blobs: `recordings/{id}.{ext}`.
	 * Local models are not here: Rust owns them end to end in the shared Hugging
	 * Face cache (see `src-tauri/src/transcription/catalog.rs`), so JS never
	 * resolves a model path.
	 */
	DB: {
		/** `recordings/` directory containing audio files. */
		async RECORDINGS() {
			return appDataPath('recordings');
		},
		/** Path for a newly written recording: `recordings/{id}.{extension}`. */
		async RECORDING_AUDIO(id: string, extension: string) {
			return appDataPath('recordings', `${id}.${extension}`);
		},
		/** Path to an existing recording file given its full filename. */
		async RECORDING_FILE(filename: string) {
			return appDataPath('recordings', filename);
		},
	},
};
