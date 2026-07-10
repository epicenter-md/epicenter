import type {
	BaseRecordingParams,
	RecorderService,
} from '$lib/services/recorder/contract';
import type { ManualRecordingEnvironment } from './contract';

export function createManualRecordingEnvironment<
	TParams extends BaseRecordingParams,
>({
	recorder,
	config,
}: {
	recorder: RecorderService<TParams>;
	config: {
		get deviceId(): string | null;
		set deviceId(deviceId: string | null);
		resolveStartParams(recordingId: string): TParams;
	};
}): ManualRecordingEnvironment {
	return {
		get deviceId() {
			return config.deviceId;
		},
		set deviceId(deviceId) {
			config.deviceId = deviceId;
		},
		resumeActiveSession: () => recorder.resumeActiveSession(),
		enumerateDevices: () => recorder.enumerateDevices(),
		startRecording: (recordingId, callbacks) =>
			recorder.startRecording(
				config.resolveStartParams(recordingId),
				callbacks,
			),
	};
}
