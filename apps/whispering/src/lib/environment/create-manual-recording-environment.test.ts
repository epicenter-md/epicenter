import { expect, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import type {
	BaseRecordingParams,
	RecorderService,
} from '$lib/services/recorder/contract';
import { createManualRecordingEnvironment } from './create-manual-recording-environment';

test('manual recording environment owns the microphone access handoff', async () => {
	let requests = 0;
	const recorder = {
		async requestAccess() {
			requests += 1;
			return Ok(undefined);
		},
		async resumeActiveSession() {
			return Ok(null);
		},
		async enumerateDevices() {
			return Ok([]);
		},
		async startRecording() {
			throw new Error('not used');
		},
	} satisfies RecorderService<BaseRecordingParams>;

	const environment = createManualRecordingEnvironment({
		recorder,
		configuration: 'bitrate',
		config: {
			deviceId: null,
			resolveStartParams: (recordingId) => ({
				recordingId,
				selectedDeviceId: null,
			}),
		},
		reportLevel() {},
	});

	expect(await environment.requestAccess()).toEqual(Ok(undefined));
	expect(requests).toBe(1);
});
