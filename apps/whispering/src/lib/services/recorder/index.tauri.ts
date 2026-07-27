import { type BlobId, parseBlobId } from '@epicenter/blobs';
import {
	asDeviceIdentifier,
	type Device,
	type DeviceAcquisitionOutcome,
} from '@epicenter/recorder';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { WhisperingRecordingState } from '$lib/constants/audio';
import { recorderErrorFromIpc } from '$lib/services/recorder/categorize-error';
import {
	type BaseRecordingParams,
	RecorderError,
	type RecorderService,
	type RecordingCallbacks,
	type RecordingSession,
} from '$lib/services/recorder/contract';
import { commands } from '$lib/tauri/commands';
// This file is the Tauri impl, so it imports the non-null capability bag
// directly from the Tauri marker rather than through the `#platform/tauri`
// seam (which resolves to `null` under the web condition).
import { tauriOnly } from '$lib/tauri.tauri';

/**
 * Native (Rust/CPAL) recording parameters. Whispering-owned: the package
 * defines only the base params; the native sample-rate knob is this app's.
 */
export type CpalRecordingParams = BaseRecordingParams & {
	sampleRate: string;
};

/**
 * Live mic loudness, emitted by the Rust capture worker to the window that owns
 * the recording. The JS side never sees PCM, so the level has to originate
 * there; this is the one recording event that crosses the boundary.
 */
const MIC_LEVEL_EVENT = 'mic-level';

async function getMicrophonePermissionStatus(): Promise<
	Result<boolean, RecorderError>
> {
	const { data: granted, error } =
		await tauriOnly.permissions.microphone.check();
	if (error) {
		return RecorderError.MicrophonePermissionDenied({ cause: error });
	}
	return Ok(granted);
}

async function requireMicrophonePermission(): Promise<
	Result<void, RecorderError>
> {
	const { data: granted, error } = await getMicrophonePermissionStatus();
	if (error) return Err(error);
	if (granted) return Ok(undefined);

	return RecorderError.MicrophonePermissionDenied();
}

async function requestMicrophonePermission(): Promise<
	Result<void, RecorderError>
> {
	const { data: alreadyGranted, error: checkError } =
		await getMicrophonePermissionStatus();
	if (checkError) return Err(checkError);
	if (alreadyGranted) return Ok(undefined);

	const { error: requestError } =
		await tauriOnly.permissions.microphone.request();
	if (requestError) {
		return RecorderError.MicrophonePermissionDenied({ cause: requestError });
	}

	const { data: grantedAfterRequest, error: recheckError } =
		await getMicrophonePermissionStatus();
	if (recheckError) return Err(recheckError);
	if (!grantedAfterRequest) return RecorderError.MicrophonePermissionDenied();

	return Ok(undefined);
}

/**
 * Enumerates available recording devices from the system.
 */
const enumerateDevices = async (): Promise<Result<Device[], RecorderError>> => {
	const { error: permissionError } = await requireMicrophonePermission();
	if (permissionError) return Err(permissionError);

	const { data: deviceNames, error: enumerateRecordingDevicesError } =
		await commands.enumerateRecordingDevices();
	if (enumerateRecordingDevicesError !== null) {
		return (
			recorderErrorFromIpc(enumerateRecordingDevicesError) ??
			RecorderError.EnumerateDevices({
				cause: enumerateRecordingDevicesError,
			})
		);
	}
	// On desktop, device names serve as both ID and label
	return Ok(
		deviceNames.map((name) => ({
			id: asDeviceIdentifier(name),
			label: name,
		})),
	);
};

/**
 * CPAL recorder service backed by the host's one recorder.
 *
 * The host owns the recording. Rust mints the blob id at `start`, records which
 * window started it, and refuses a competing start rather than displacing a
 * recording some other window is relying on. So this file holds no lifecycle
 * invariant of its own: it names a recording by id on every call and lets Rust
 * answer whether that recording is still this window's to end.
 *
 * A recording outlives a JS reload, because the reload does not destroy the
 * window and the host keeps the capture running. `resumeActiveSession` asks the
 * host for the recording this window owns and rebuilds a wrapper around it.
 *
 * Stop atomically publishes the blob under the minted id and returns the
 * host's exact duration and byte length. There is no raw PCM on the wire.
 */
function createCpalRecorder() {
	let activeSession: RecordingSession | null = null;

	/**
	 * Wrap a live host recording.
	 *
	 * `onLevel` is the caller's meter sink, present only when this window
	 * started the recording: a session rebuilt after a reload has no caller to
	 * feed, so its meter stays dark until the next recording.
	 */
	function buildSession(
		audioBlobId: BlobId,
		onLevel: ((level: number) => void) | null,
	) {
		const subscribers = new Set<(s: WhisperingRecordingState) => void>();
		let currentState: WhisperingRecordingState = 'RECORDING';
		let unlistenLevel: Promise<UnlistenFn> | null = onLevel
			? listen<number>(MIC_LEVEL_EVENT, (event) => onLevel(event.payload))
			: null;

		// Takes `session` as an argument rather than closing over the const
		// declared below, so it stays TDZ-safe if a future caller invokes
		// teardown from a path declared above the `session = ...` initializer.
		const teardown = (session: RecordingSession) => {
			if (activeSession === session) activeSession = null;
			if (unlistenLevel) {
				void unlistenLevel.then((unlisten) => unlisten());
				unlistenLevel = null;
			}
			if (currentState === 'IDLE') return;
			currentState = 'IDLE';
			for (const handler of subscribers) handler('IDLE');
		};

		const session = {
			audioBlobId,

			stop: async () => {
				const { data: stopped, error: stopError } =
					await commands.stopRecording(audioBlobId);
				// Torn down either way: whether the host delivered a blob or
				// refused, this window is no longer recording.
				teardown(session);
				if (stopError !== null) {
					return (
						recorderErrorFromIpc(stopError) ??
						RecorderError.StopFailed({ cause: stopError })
					);
				}
				// The id came back from the host that minted it, so parsing is a
				// boundary formality rather than a round-trip assertion.
				const parsedId = parseBlobId(stopped.audioBlobId);
				if (parsedId === undefined) {
					return RecorderError.StopFailed({
						cause: new Error('The host returned an invalid blob id.'),
					});
				}
				return Ok({
					audioBlobId: parsedId,
					durationMs: stopped.durationMs,
					byteLength: stopped.byteLength,
				});
			},

			cancel: async () => {
				const { error: cancelError } =
					await commands.cancelRecording(audioBlobId);

				// Tear down unconditionally first so this window can never wedge
				// in RECORDING, even when the host refused.
				teardown(session);

				if (cancelError !== null) {
					return (
						recorderErrorFromIpc(cancelError) ??
						RecorderError.CancelFailed({ cause: cancelError })
					);
				}
				return Ok(undefined);
			},

			subscribe(handler) {
				subscribers.add(handler);
				// Fire current state immediately so callers don't have to mirror
				// 'RECORDING' at attach time.
				handler(currentState);
				return () => {
					subscribers.delete(handler);
				};
			},
		} satisfies RecordingSession;

		return session;
	}

	return {
		resumeActiveSession: async (): Promise<
			Result<RecordingSession | null, RecorderError>
		> => {
			// If we still hold the in-memory pointer, prefer it; otherwise ask the
			// host, in case a recording outlived a JS reload.
			if (activeSession) return Ok(activeSession);

			const { data: liveBlobId, error: currentError } =
				await commands.currentRecording();
			if (currentError !== null) {
				return RecorderError.GetStateFailed({ cause: currentError });
			}
			if (!liveBlobId) return Ok(null);
			const parsedId = parseBlobId(liveBlobId);
			if (parsedId === undefined) {
				return RecorderError.GetStateFailed({
					cause: new Error('The host returned an invalid blob id.'),
				});
			}

			const rehydrated = buildSession(parsedId, null);
			activeSession = rehydrated;
			return Ok(rehydrated);
		},

		enumerateDevices,

		startRecording: async (
			{ selectedDeviceId, sampleRate }: CpalRecordingParams,
			{ onLevel }: RecordingCallbacks,
		) => {
			const { error: permissionError } = await requestMicrophonePermission();
			if (permissionError) return Err(permissionError);

			const { data: devices, error: enumerateError } = await enumerateDevices();
			if (enumerateError !== null) return Err(enumerateError);

			const deviceIds = devices.map((d) => d.id);
			const fallbackDeviceId = deviceIds.at(0);
			// Empty device list: there is no microphone to fall back to, whether or
			// not one was previously selected. Same condition, same recovery as a
			// device that vanishes mid-open, so it surfaces the one NoInputDevice.
			if (!fallbackDeviceId) {
				return RecorderError.NoInputDevice();
			}

			const deviceOutcome: DeviceAcquisitionOutcome = (() => {
				if (!selectedDeviceId) {
					return {
						outcome: 'fallback',
						reason: 'no-device-selected',
						deviceId: fallbackDeviceId,
					};
				}

				if (deviceIds.includes(selectedDeviceId)) {
					return { outcome: 'success', deviceId: selectedDeviceId };
				}

				return {
					outcome: 'fallback',
					reason: 'preferred-device-unavailable',
					deviceId: fallbackDeviceId,
				};
			})();

			const sampleRateNum = sampleRate ? Number.parseInt(sampleRate, 10) : null;

			const { data: audioBlobId, error: startError } =
				await commands.startRecording(deviceOutcome.deviceId, sampleRateNum);
			if (startError !== null) {
				return (
					recorderErrorFromIpc(startError) ??
					RecorderError.StartFailed({ cause: startError })
				);
			}
			const parsedId = parseBlobId(audioBlobId);
			if (parsedId === undefined) {
				return RecorderError.StartFailed({
					cause: new Error('The host returned an invalid blob id.'),
				});
			}

			const session = buildSession(parsedId, onLevel);
			activeSession = session;
			return Ok({ session, deviceAcquisition: deviceOutcome });
		},
	} satisfies RecorderService<CpalRecordingParams>;
}

export const ManualRecorderLive: RecorderService<CpalRecordingParams> =
	createCpalRecorder();
