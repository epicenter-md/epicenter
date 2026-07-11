import type { Device, DeviceAcquisitionOutcome } from '@epicenter/recorder';
import type { Result } from 'wellcrafted/result';
import type { CaptureSurface } from '$lib/constants/audio';
import type { PlaybackSuppressionSetting } from '$lib/constants/audio/playback-suppression';
import type { CursorDelivery } from '$lib/desktop/contract';
import type { TranscriptionError } from '$lib/operations/transcription-use-case';
import type { PlatformAuth } from '$lib/platform/types';
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

export type TranscriptionEnvironment = {
	providers: readonly TranscriptionServiceId[];
	localModels: LocalModels;
	transcribeAndPersist(
		recordingId: string,
	): Promise<Result<string, TranscriptionError>>;
	prewarmSelectedModel(): void;
};

/**
 * The complete host binding for shared Whispering code. Members belong here
 * only when the product operation exists in both hosts and the implementation
 * changes at build time; Epicenter-only operations enter through `#desktop`
 * instead.
 */
export type WhisperingEnvironment = {
	auth: PlatformAuth;
	artifacts: BlobStore;
	captureSurfaces: readonly CaptureSurface[];
	downloads: DownloadService;
	delivery: CursorDelivery;
	notifications: (title: string, body: string | undefined) => void;
	/**
	 * Suppress other apps' audio for the life of a recording, keyed by recording
	 * id. Both verbs are fire-and-forget and idempotent: the host owns every
	 * lifecycle edge, and a failure never disrupts the recording it accompanies.
	 * Hosts that cannot touch other apps' audio report `supported: false` and
	 * no-op both verbs.
	 */
	playbackSuppression: {
		/** Whether this host can lower, mute, or pause other apps' audio while recording. */
		supported: boolean;
		begin(recordingId: string, mode: PlaybackSuppressionSetting): Promise<void>;
		end(recordingId: string | null): Promise<void>;
	};
	recording: ManualRecordingEnvironment;
	text: TextService;
	transcription: TranscriptionEnvironment;
};
