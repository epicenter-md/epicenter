/**
 * Platform-neutral contracts shared with the generated native bindings.
 *
 * Vite resolves modules before it erases TypeScript-only imports. Importing a
 * type from `commands.ts` therefore retains that module's Tauri side effects in
 * a browser build. Keep the small cross-platform vocabulary here and verify it
 * against the generated bindings in `commands.test-d.ts`.
 */

export type CatalogError =
	| { name: 'UnknownModel'; message: string }
	| { name: 'DownloadFailed'; message: string }
	| { name: 'DeleteFailed'; message: string };

export type DictationCapability =
	| 'unknown'
	| 'inactive'
	| 'untrusted'
	| 'active'
	| 'broken';

export type DownloadProgress = {
	bytesReceived: number | null;
	totalBytes: number | null;
};

export type IpcRecorderError =
	| { name: 'PermissionDenied'; message: string }
	| { name: 'NoInputDevice'; message: string }
	| { name: 'Failed'; message: string };

export type ModelInfo = {
	id: string;
	name: string;
	description: string;
	sizeBytes: number | null;
	supportsPrompt: boolean;
	supportsLanguage: boolean;
	recommended: boolean;
	downloaded: boolean;
};

export type RecordingArtifact = {
	id: string;
	durationMs: number;
	byteLength: number;
	mimeType: string;
};

export type TranscriptionError =
	| { name: 'AudioReadError'; message: string }
	| { name: 'ModelLoadError'; message: string }
	| { name: 'TranscriptionError'; message: string }
	| { name: 'ConfigError'; message: string };

export type TranscriptionSpec = {
	modelId: string;
	language?: string | null;
	initialPrompt?: string | null;
};
