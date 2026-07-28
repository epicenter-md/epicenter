import { type BlobId, parseBlobId } from '@epicenter/blobs';
import {
	asDeviceIdentifier,
	type Device,
	type DeviceAcquisitionOutcome,
} from '@epicenter/recorder';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { recorderErrorFromIpc } from '$lib/services/recorder/categorize-error';
import {
	type BaseRecordingParams,
	RecorderError,
	type RecorderService,
	type Recording,
	type RecordingEndedReason,
} from '$lib/services/recorder/contract';
import type { DeviceAcquisition as IpcDeviceAcquisition } from '$lib/tauri/commands';
import { commands, events } from '$lib/tauri/commands';
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
 * there.
 */
const MIC_LEVEL_EVENT = 'mic-level';

/**
 * Brand the host's device name as a `DeviceIdentifier`. The two types are
 * structurally identical; on desktop a device's name is its id, and this
 * boundary is where that becomes a checked fact rather than a convention.
 */
function toDeviceAcquisition(
	device: IpcDeviceAcquisition,
): DeviceAcquisitionOutcome {
	return device.outcome === 'success'
		? { outcome: 'success', deviceId: asDeviceIdentifier(device.deviceId) }
		: {
				outcome: 'fallback',
				reason: device.reason,
				deviceId: asDeviceIdentifier(device.deviceId),
			};
}

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
 * Enumerate recording devices, for a device picker. Starting a recording does
 * not go through here: the host resolves and reports its own device.
 */
const enumerateDevices = async (): Promise<Result<Device[], RecorderError>> => {
	const { error: permissionError } = await requireMicrophonePermission();
	if (permissionError) return Err(permissionError);

	const { data: deviceNames, error: enumerateError } =
		await commands.enumerateRecordingDevices();
	if (enumerateError !== null) {
		return recorderErrorFromIpc(enumerateError);
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
 * window started it, resolves the microphone, and refuses a competing start
 * rather than displacing a recording some other window is relying on. So this
 * file holds no lifecycle invariant of its own: it names a recording by id on
 * every call and lets Rust answer whether that recording is still this
 * window's to end.
 *
 * A recording outlives a JS reload, because the reload does not destroy the
 * window and the host keeps capturing. `current()` asks the host for the
 * recording this window owns and rebuilds a fully usable wrapper around it,
 * meter included.
 */
function createCpalRecorder(): RecorderService<CpalRecordingParams> {
	/**
	 * Wrap a live host recording.
	 *
	 * Listeners are attached on demand rather than at construction, which is
	 * what lets a recording recovered by `current()` be exactly as capable as
	 * one just started: there is no callback that had to be supplied earlier.
	 */
	function buildRecording(
		audioBlobId: BlobId,
		device: DeviceAcquisitionOutcome,
		endedReason: RecordingEndedReason | null,
	): Recording {
		// Every host listener this recording opened, torn down together the moment
		// no more of them can fire: after a stop, a cancel, or the capture ending.
		// This gates events, not the recording. A recording whose capture ended is
		// still stoppable, and stopping it needs no listener.
		const unlisteners = new Set<Promise<UnlistenFn>>();
		// A recording recovered with its capture already ended will never receive
		// another level or another ending, so it starts deaf rather than
		// subscribing to events the host will not send.
		let listening = endedReason === null;

		const stopListening = () => {
			listening = false;
			for (const unlisten of unlisteners) {
				void unlisten.then((stop) => stop());
			}
			unlisteners.clear();
		};

		/** Attach a host listener that stops when this recording stops listening. */
		const track = (unlisten: Promise<UnlistenFn>) => {
			if (!listening) {
				void unlisten.then((stop) => stop());
				return () => {};
			}
			unlisteners.add(unlisten);
			return () => {
				unlisteners.delete(unlisten);
				void unlisten.then((stop) => stop());
			};
		};

		return {
			audioBlobId,
			device,
			endedReason,

			stop: async () => {
				const { data: stopped, error: stopError } =
					await commands.stopRecording(audioBlobId);
				// Either way, whether the host delivered a blob or refused, this
				// recording is resolved and nothing more will be sent about it.
				stopListening();
				if (stopError !== null) {
					return recorderErrorFromIpc(stopError);
				}
				// The id came back from the host that minted it, so parsing is a
				// boundary formality rather than a round-trip assertion.
				const parsedId = parseBlobId(stopped.audioBlobId);
				if (parsedId === undefined) {
					return RecorderError.RecorderFailed({
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
				stopListening();
				if (cancelError !== null) {
					return recorderErrorFromIpc(cancelError);
				}
				return Ok(undefined);
			},

			onLevel: (handler) =>
				track(
					listen<number>(MIC_LEVEL_EVENT, (event) => handler(event.payload)),
				),

			onEnded: (handler) =>
				track(
					events.recordingEndedEvent.listen((event) => {
						// The host targets the owning window, but a window can outlive
						// one recording and start another, so the id still has to match.
						if (event.payload.audioBlobId !== audioBlobId) return;
						// The capture is over, so the level meter has nothing left to
						// report and this event cannot fire twice. The recording is
						// still the caller's to stop.
						stopListening();
						handler(event.payload.reason);
					}),
				),
		};
	}

	return {
		current: async () => {
			const { data: live, error: currentError } =
				await commands.currentRecording();
			if (currentError !== null) {
				return recorderErrorFromIpc(currentError);
			}
			if (!live) return Ok(null);
			const parsedId = parseBlobId(live.audioBlobId);
			if (parsedId === undefined) {
				return RecorderError.RecorderFailed({
					cause: new Error('The host returned an invalid blob id.'),
				});
			}
			return Ok(
				buildRecording(
					parsedId,
					toDeviceAcquisition(live.device),
					live.endedReason,
				),
			);
		},

		enumerateDevices,

		start: async ({ selectedDeviceId, sampleRate }: CpalRecordingParams) => {
			const { error: permissionError } = await requestMicrophonePermission();
			if (permissionError) return Err(permissionError);

			const sampleRateNum = sampleRate ? Number.parseInt(sampleRate, 10) : null;

			// No device enumeration first: the host resolves the requested device,
			// falls back to the system default when it is gone, and reports which
			// one it opened.
			const { data: started, error: startError } =
				await commands.startRecording(selectedDeviceId, sampleRateNum);
			if (startError !== null) {
				return recorderErrorFromIpc(startError);
			}
			const parsedId = parseBlobId(started.audioBlobId);
			if (parsedId === undefined) {
				return RecorderError.RecorderFailed({
					cause: new Error('The host returned an invalid blob id.'),
				});
			}

			// A freshly started recording never carries an ended reason: the host
			// only just opened its microphone.
			return Ok(
				buildRecording(parsedId, toDeviceAcquisition(started.device), null),
			);
		},
	};
}

export const ManualRecorderLive: RecorderService<CpalRecordingParams> =
	createCpalRecorder();
