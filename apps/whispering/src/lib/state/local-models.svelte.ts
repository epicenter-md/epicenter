/**
 * The single source of truth for the local GGUF model catalog, projected from
 * Rust. Rust owns which models exist, their capabilities, and their
 * download/cache status (`transcription::catalog`); this store is the thin
 * reactive view every UI surface reads.
 *
 * It unifies the two kinds of truth a model picker needs:
 *
 *  - CATALOG STATE, at rest: the models Rust offers, each carrying whether it is
 *    already downloaded in the shared Hugging Face cache. Refreshed via
 *    `refresh()` on first use, window focus, and after every mutation.
 *  - IN-FLIGHT TRANSFERS, in motion: downloads underway, with progress and a
 *    cancel flag. Transient, fed by the download Channel; never in the catalog
 *    scan yet.
 *
 * A global singleton: a download started anywhere updates the one store and
 * every mounted view re-reads reactively. Selection (the active model id) is
 * deliberately NOT here: it lives in deviceConfig
 * (`transcription.local.selectedModel`) and is read by the transcribe
 * dispatcher. Presence (this store) and selection (deviceConfig) are different
 * concerns; the selector joins them.
 */
import { SvelteMap } from 'svelte/reactivity';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { tauri } from '#platform/tauri';
import {
	type CatalogError,
	type DownloadProgress,
	type ModelInfo,
} from '$lib/tauri/commands.types';

export type ModelDownloadState =
	| { type: 'not-downloaded' }
	| { type: 'downloading'; progress: number; cancelling: boolean }
	| { type: 'ready' };

/**
 * The result of a `download()`: the outcome plus the model id to select on
 * success, `Err` on failure, or `null` when the call was a no-op (a download
 * was already in flight, or a cancel arrived before any transfer started).
 */
export type ModelDownloadResult = Result<
	{ outcome: 'downloaded' | 'already-installed'; modelId: string },
	CatalogError
> | null;

function createLocalModels() {
	// CATALOG STATE. `null` until the first load so the UI can tell "loading"
	// from "empty". Each entry carries its own `downloaded` verdict from the one
	// Rust scan, so "ready" is a pure read with no second source to drift from.
	let models = $state<ModelInfo[] | null>(null);

	// IN-FLIGHT TRANSFERS, keyed by model id. The map IS the re-entry gate: a key
	// present means a transfer owns that model, cleared only when that same run
	// settles, so a cancel can never reopen the door for a second overlapping
	// download over the same file. `id` is unique per attempt, so the Rust
	// registry maps it to exactly one transfer; `cancelling` gates late progress.
	const transfers = new SvelteMap<
		string,
		{ id: string; progress: number; cancelling: boolean }
	>();
	let attempts = 0;

	async function refresh() {
		if (!tauri) return;
		models = await tauri.transcription.listModels();
	}

	void refresh();

	return {
		/** The catalog scan: the single source every view reads. */
		get models() {
			return models ?? [];
		},
		/** Whether the first scan has landed (so "empty" differs from "loading"). */
		get loaded() {
			return models !== null;
		},
		/** The catalog model for an id, if any. */
		find(modelId: string): ModelInfo | undefined {
			return (models ?? []).find((model) => model.id === modelId);
		},
		/** Where a model stands: a live transfer, else catalog download truth. */
		stateOf(model: ModelInfo): ModelDownloadState {
			const transfer = transfers.get(model.id);
			if (transfer)
				return {
					type: 'downloading',
					progress: transfer.progress,
					cancelling: transfer.cancelling,
				};
			return model.downloaded ? { type: 'ready' } : { type: 'not-downloaded' };
		},

		/**
		 * Re-read the catalog + download status from Rust. The shared HF cache can
		 * change outside the app, so views call this on window focus.
		 */
		refresh,

		/**
		 * Download a model into the shared HF cache, skipping when it is already
		 * present. Re-scans before releasing the gate so the computed state lands
		 * directly on `ready`.
		 */
		async download(model: ModelInfo): Promise<ModelDownloadResult> {
			if (!tauri) return null;
			if (transfers.has(model.id)) return null;
			const id = `${model.id}#${++attempts}`;
			transfers.set(model.id, { id, progress: 0, cancelling: false });

			// Already downloaded? A fresh scan is the one truth; skip the transfer.
			await refresh();
			if ((models ?? []).find((m) => m.id === model.id)?.downloaded) {
				transfers.delete(model.id);
				return Ok({ modelId: model.id, outcome: 'already-installed' });
			}

			// A cancel that arrived during the install check stops here, reported as
			// a no-op like an in-flight call.
			if (transfers.get(model.id)?.cancelling) {
				transfers.delete(model.id);
				return null;
			}

			const onProgress = ({ bytesReceived, totalBytes }: DownloadProgress) => {
				// f64 fields arrive as `number | null` (specta guards non-finite
				// floats). Guard the total anyway.
				const received = bytesReceived ?? 0;
				const total = totalBytes && totalBytes > 0 ? totalBytes : 0;
				if (total <= 0) return;
				const progress = Math.min(100, Math.round((received / total) * 100));
				const transfer = transfers.get(model.id);
				if (transfer && !transfer.cancelling)
					transfers.set(model.id, { ...transfer, progress });
			};

			const { error } = await tauri.transcription.downloadModel(
				model.id,
				id,
				onProgress,
			);
			if (error) {
				const wasCancelled = transfers.get(model.id)?.cancelling ?? false;
				transfers.delete(model.id);
				// A requested cancel is the cause of this error: a clean stop, not a
				// failure. Report it as a no-op so callers raise no error toast.
				return wasCancelled ? null : Err(error);
			}

			await refresh();
			transfers.delete(model.id);
			return Ok({ modelId: model.id, outcome: 'downloaded' });
		},

		/**
		 * Request cancellation of an in-flight download. Marks it cancelling (the UI
		 * shows "Cancelling…") and aborts its transfer in Rust; the still-running
		 * `download()` drops back to `not-downloaded` once the abort surfaces.
		 * A no-op when nothing is downloading.
		 */
		async cancel(model: ModelInfo): Promise<void> {
			if (!tauri) return;
			const transfer = transfers.get(model.id);
			if (!transfer) return;
			transfers.set(model.id, { ...transfer, cancelling: true });
			await tauri.transcription.cancelDownload(transfer.id);
		},

		/** Remove a downloaded model's file from the shared HF cache. */
		async remove(model: ModelInfo): Promise<Result<null, CatalogError>> {
			if (!tauri)
				throw new Error('Local models require the Epicenter desktop app');
			const result = await tauri.transcription.deleteModel(model.id);
			if (!result.error) await refresh();
			return result;
		},
	};
}

/** The one shared local-models store. */
export const localModels = createLocalModels();
