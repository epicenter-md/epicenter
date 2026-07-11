import type { Result } from 'wellcrafted/result';
import type { TextError } from '$lib/services/text/types';
import type {
	PlaybackSuppressionMode,
	WriteTextOutcome,
} from '$lib/tauri/bindings.gen';
import type {
	CatalogError,
	DictationCapability,
	DownloadProgress,
	ModelInfo,
	TranscriptionError,
	TranscriptionSpec,
	UnloadPolicy,
} from '$lib/tauri/commands.types';

export type CursorDelivery = {
	readonly supportsCursor: boolean;
	write(
		text: string,
		keepOnClipboard: boolean,
	): Promise<Result<WriteTextOutcome, TextError>>;
	pressEnter(): Promise<Result<void, TextError>>;
	copySelection(): Promise<Result<void, TextError>>;
};

export type GlobalShortcutRegistration = {
	commandId: string;
	accelerator: string;
};

export type DesktopShortcuts = {
	replace(
		registrations: GlobalShortcutRegistration[],
	): Promise<Result<void, string>>;
	onTriggered(
		handler: (trigger: {
			commandId: string;
			state: 'Pressed' | 'Released';
		}) => void,
	): Promise<() => void>;
};

export type DesktopDictation = {
	setCursorDeliveryEnabled(enabled: boolean): Promise<void>;
	getCapability(): Promise<DictationCapability>;
	onCapabilityChanged(
		handler: (capability: DictationCapability) => void,
	): Promise<() => void>;
	requestAccess(): Promise<void>;
	openAccessSettings(): Promise<Result<void, string>>;
};

export type DesktopLocalTranscription = {
	listModels(): Promise<ModelInfo[]>;
	downloadModel(
		modelId: string,
		downloadId: string,
		onProgress: (progress: DownloadProgress) => void,
	): Promise<Result<void, CatalogError>>;
	cancelDownload(downloadId: string): Promise<void>;
	deleteModel(modelId: string): Promise<Result<void, CatalogError>>;
	prewarm(spec: TranscriptionSpec): Promise<Result<void, TranscriptionError>>;
	transcribe(
		recordingId: string,
		spec: TranscriptionSpec,
	): Promise<Result<string, TranscriptionError>>;
	setUnloadPolicy(policy: UnloadPolicy): Promise<void>;
};

export type DesktopPlaybackSuppression = {
	begin(recordingId: string, mode: PlaybackSuppressionMode): Promise<void>;
	end(recordingId: string): Promise<void>;
};

/** Complete product operations that exist only in an Epicenter build. */
export type WhisperingDesktop = {
	shortcuts: DesktopShortcuts;
	dictation: DesktopDictation;
	localTranscription: DesktopLocalTranscription;
	playbackSuppression: DesktopPlaybackSuppression;
	delivery: CursorDelivery;
};
