import type { Device, DeviceAcquisitionOutcome } from '@epicenter/recorder';
import type { Result } from 'wellcrafted/result';
import type { CaptureSurface } from '$lib/constants/audio';
import type { CursorDelivery } from '$lib/desktop/contract';
import type { TranscriptionError } from '$lib/operations/transcription-use-case';
import type { Os, PlatformAuth } from '$lib/platform/types';
import type { BlobStore } from '$lib/services/blob-store/types';
import type { DownloadService } from '$lib/services/download/types';
import type {
	RecorderError,
	RecordingCallbacks,
	RecordingSession,
} from '$lib/services/recorder/contract';
import type { TextService } from '$lib/services/text/types';
import type { TranscriptionServiceId } from '$lib/services/transcription/providers';
import type { LocalModels } from '$lib/state/local-models.svelte';

type StartRecordingResult = Result<
	{
		session: RecordingSession;
		deviceAcquisition: DeviceAcquisitionOutcome;
	},
	RecorderError
>;

/** Complete manual-recording capability for the selected hosting environment. */
export type ManualRecordingEnvironment = {
	configuration: 'bitrate' | 'sampleRate';
	get deviceId(): string | null;
	set deviceId(deviceId: string | null);
	resumeActiveSession(): Promise<
		Result<RecordingSession | null, RecorderError>
	>;
	enumerateDevices(): Promise<Result<Device[], RecorderError>>;
	requestAccess(): Promise<Result<void, RecorderError>>;
	startRecording(
		recordingId: string,
		callbacks: RecordingCallbacks,
	): Promise<StartRecordingResult>;
	reportLevel(level: number): void;
};

/**
 * Product capabilities that are complete in both browser and Epicenter builds.
 * Members belong here only when the product operation exists in both hosts and
 * the implementation changes at build time.
 */
export type WhisperingBaseEnvironment = {
	auth: PlatformAuth;
	artifacts: BlobStore;
	/** Whether this host can lower, mute, or pause other apps' audio while recording. */
	canSuppressPlayback: boolean;
	captureSurfaces: readonly CaptureSurface[];
	downloads: DownloadService;
	delivery: CursorDelivery;
	notifications: (title: string, body: string | undefined) => void;
	os: Os;
	recording: ManualRecordingEnvironment;
	text: TextService;
};

export type TranscriptionEnvironment = {
	providers: readonly TranscriptionServiceId[];
	localModels: LocalModels;
	transcribeAndPersist(
		recordingId: string,
	): Promise<Result<string, TranscriptionError>>;
	prewarmSelectedModel(): void;
};

export type WhisperingEnvironment = WhisperingBaseEnvironment & {
	transcription: TranscriptionEnvironment;
};
