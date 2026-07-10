import { tryAsync } from 'wellcrafted/result';
import { commands } from '$lib/tauri/commands';
import { BlobError, type BlobStore } from './types';

const NATIVE_ARTIFACT_MIME_TYPE = 'audio/wav';

/**
 * Native CPAL artifacts are owned by Rust and addressed only by recording id.
 * The WebView receives bytes for playback, never a filesystem path.
 *
 * Browser Blob, VAD, and import persistence is intentionally deferred for the
 * first native milestone. Calling `save` reports that unsupported boundary
 * instead of quietly granting generic filesystem write authority.
 */
export function createFileSystemBlobStore() {
	const urlCache = new Map<string, string>();

	return {
		async save(_key, _blob) {
			return BlobError.WriteFailed({
				cause: new Error(
					'Desktop Blob, VAD, and import artifact persistence is not available yet',
				),
			});
		},

		async delete(idOrIds) {
			const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
			return tryAsync({
				try: async () => {
					const { error } = await commands.deleteRecordingArtifacts(ids);
					if (error !== null) throw error;
				},
				catch: (error) => BlobError.WriteFailed({ cause: error }),
			});
		},

		async getBlob(key) {
			return tryAsync({
				try: async () => {
					const { data, error } = await commands.readRecordingArtifact(key);
					if (error !== null) throw new Error(error);
					return new Blob([data], { type: NATIVE_ARTIFACT_MIME_TYPE });
				},
				catch: (error) => BlobError.ReadFailed({ cause: error }),
			});
		},

		async ensurePlaybackUrl(key) {
			return tryAsync({
				try: async () => {
					const cachedUrl = urlCache.get(key);
					if (cachedUrl) return cachedUrl;

					const { data: blob, error } = await this.getBlob(key);
					if (error !== null) throw error;

					const url = URL.createObjectURL(blob);
					urlCache.set(key, url);
					return url;
				},
				catch: (error) => BlobError.ReadFailed({ cause: error }),
			});
		},

		revokeUrl(key) {
			const url = urlCache.get(key);
			if (!url) return;
			URL.revokeObjectURL(url);
			urlCache.delete(key);
		},

		async clear() {
			for (const url of urlCache.values()) URL.revokeObjectURL(url);
			urlCache.clear();
			return tryAsync({
				try: async () => {
					const { error } = await commands.clearRecordingArtifacts();
					if (error !== null) throw error;
				},
				catch: (error) => BlobError.WriteFailed({ cause: error }),
			});
		},
	} satisfies BlobStore;
}
