/**
 * Where Whispering points a person at files the desktop host owns.
 *
 * `appDataDir()` is an IPC call into Tauri's `PathResolver::app_data_dir`, the
 * same function the native recorder resolves `<root>/blobs` through, so this
 * names the host's directory rather than computing a second one. With the
 * `so.epicenter` identifier that is:
 *   macOS:   ~/Library/Application Support/so.epicenter/
 *   Windows: %APPDATA%/so.epicenter/
 *   Linux:   ~/.local/share/so.epicenter/
 *
 * It is not the whole rule, and the gap is worth knowing about.
 * `EPICENTER_DATA_DIR` moves that root; the Bun host and the native recorder
 * both honour it, Tauri's resolver does not, and a WebView cannot read the
 * process environment to make up the difference. Under an override this opens
 * the platform default while the recordings are somewhere else. Closing it is
 * the same open question as who tells the recorder where blobs live (ADR-0201):
 * whoever ends up injecting that root injects it here too.
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
	 * Filesystem storage for local blobs: `blobs/{id}/`.
	 * Local models are not here: Rust owns them end to end in the shared Hugging
	 * Face cache (see `src-tauri/src/transcription/catalog.rs`), so JS never
	 * resolves a model path.
	 */
	DB: {
		/** `blobs/` directory containing immutable local blob directories. */
		async BLOBS() {
			return appDataPath('blobs');
		},
	},
};
