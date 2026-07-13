import type {
	BaseRecordingParams,
	RecorderService,
} from '$lib/services/recorder/contract';
import type {
	ManualRecordingEnvironment,
	ManualRecordingStartOptions,
} from './contract';

export function createManualRecordingEnvironment<
	TParams extends BaseRecordingParams,
>({
	recorder,
	config,
	configuration,
	reportLevel,
}: {
	recorder: RecorderService<TParams>;
	configuration: ManualRecordingEnvironment['configuration'];
	config: {
		get deviceId(): string | null;
		set deviceId(deviceId: string | null);
		resolveStartParams(
			recordingId: string,
			options: ManualRecordingStartOptions,
		): TParams;
	};
	reportLevel(level: number): void;
}): ManualRecordingEnvironment {
	return {
		configuration,
		get deviceId() {
			return config.deviceId;
		},
		set deviceId(deviceId) {
			config.deviceId = deviceId;
		},
		resumeActiveSession: () => recorder.resumeActiveSession(),
		enumerateDevices: () => recorder.enumerateDevices(),
		requestAccess: () => recorder.requestAccess(),
		startRecording: (recordingId, options, callbacks) =>
			recorder.startRecording(
				config.resolveStartParams(recordingId, options),
				callbacks,
			),
		reportLevel,
	};
}
