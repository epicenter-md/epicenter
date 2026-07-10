import type { Device, DeviceAcquisitionOutcome } from '@epicenter/recorder';
import type { Result } from 'wellcrafted/result';
import type { Os, PlatformAuth } from '$lib/platform/types';
import type { BlobStore } from '$lib/services/blob-store/types';
import type { DownloadService } from '$lib/services/download/types';
import type {
	RecorderError,
	RecordingCallbacks,
	RecordingSession,
} from '$lib/services/recorder/contract';
import type { TextService } from '$lib/services/text/types';

type StartRecordingResult = Result<
	{
		session: RecordingSession;
		deviceAcquisition: DeviceAcquisitionOutcome;
	},
	RecorderError
>;

/** Complete manual-recording capability for the selected hosting environment. */
export type ManualRecordingEnvironment = {
	get deviceId(): string | null;
	set deviceId(deviceId: string | null);
	resumeActiveSession(): Promise<
		Result<RecordingSession | null, RecorderError>
	>;
	enumerateDevices(): Promise<Result<Device[], RecorderError>>;
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
export type WhisperingEnvironment = {
	auth: PlatformAuth;
	artifacts: BlobStore;
	downloads: DownloadService;
	notifications: (title: string, body: string | undefined) => void;
	os: Os;
	recording: ManualRecordingEnvironment;
	text: TextService;
};
