import { expect, test } from 'bun:test';
import { asDeviceIdentifier } from '@epicenter/recorder';
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

test('manual recording environment threads start policy into platform params', async () => {
	const receivedParams: Array<BaseRecordingParams & { suppression: string }> =
		[];
	const recorder = {
		async requestAccess() {
			return Ok(undefined);
		},
		async resumeActiveSession() {
			return Ok(null);
		},
		async enumerateDevices() {
			return Ok([]);
		},
		async startRecording(params) {
			receivedParams.push(params);
			return Ok({
				session: {
					recordingId: params.recordingId,
					async stop() {
						throw new Error('not used');
					},
					async cancel() {
						return Ok(undefined);
					},
					subscribe() {
						return () => {};
					},
				},
				deviceAcquisition: {
					outcome: 'success' as const,
					deviceId: asDeviceIdentifier('mic'),
				},
			});
		},
	} satisfies RecorderService<BaseRecordingParams & { suppression: string }>;

	const environment = createManualRecordingEnvironment({
		recorder,
		configuration: 'sampleRate',
		config: {
			deviceId: null,
			resolveStartParams: (recordingId, options) => ({
				recordingId,
				selectedDeviceId: null,
				suppression: options.playbackSuppression,
			}),
		},
		reportLevel() {},
	});

	await environment.startRecording(
		'recording-1',
		{ playbackSuppression: 'mute' },
		{ onLevel() {} },
	);

	expect(receivedParams).toEqual([
		{
			recordingId: 'recording-1',
			selectedDeviceId: null,
			suppression: 'mute',
		},
	]);
});
