import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { createLogger } from 'wellcrafted/logger';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { WhisperingRecordingState } from '$lib/constants/audio';
import { categorizeRecorderError } from '$lib/services/recorder/categorize-error';
import {
	asDeviceIdentifier,
	type CpalRecordingParams,
	type Device,
	type DeviceAcquisitionOutcome,
	RecorderError,
	type RecorderService,
	type RecordingSession,
} from '$lib/services/recorder/types';
import { tauriOnly } from '$lib/tauri';
import { commands } from '$lib/tauri/commands';

const log = createLogger('whispering/recorder/cpal');

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
	Result<true, RecorderError>
> {
	const { data: granted, error } = await getMicrophonePermissionStatus();
	if (error) return Err(error);
	if (granted) return Ok(true);

	return RecorderError.MicrophonePermissionDenied();
}

async function requestMicrophonePermission(): Promise<
	Result<true, RecorderError>
> {
	const { data: alreadyGranted, error: checkError } =
		await getMicrophonePermissionStatus();
	if (checkError) return Err(checkError);
	if (alreadyGranted) return Ok(true);

	const { error: requestError } =
		await tauriOnly.permissions.microphone.request();
	if (requestError) {
		return RecorderError.MicrophonePermissionDenied({ cause: requestError });
	}

	const { data: grantedAfterRequest, error: recheckError } =
		await getMicrophonePermissionStatus();
	if (recheckError) return Err(recheckError);
	if (!grantedAfterRequest) return RecorderError.MicrophonePermissionDenied();

	return Ok(true);
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
			categorizeRecorderError(enumerateRecordingDevicesError) ??
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
 * CPAL recorder service that uses the Rust CPAL backend.
 *
 * Constructed via a factory so the per-session lifecycle (stop/cancel/
 * subscribe) lives on the returned `RecordingSession`. The service itself
 * only holds a pointer to the active session for reload recovery through
 * `resumeActiveSession`; once stop/cancel runs, that pointer clears.
 *
 * Unlike navigator, a cpal session can outlive a JS reload because the
 * Rust process keeps the cpal stream alive. `resumeActiveSession` consults
 * Rust via `get_current_recording_id` and reattaches a new
 * `RecordingSession` wrapper if Rust still has one going.
 *
 * Stop returns a `RecordingArtifact` handle: Rust writes the durable WAV
 * to `<appDataDir>/recordings/{id}.wav` and the JS side refers to the
 * recording by id from then on. There is no raw PCM on the wire.
 */
function createCpalRecorder() {
	let activeSession: RecordingSession | null = null;

	function buildSession(recordingId: string) {
		const subscribers = new Set<(s: WhisperingRecordingState) => void>();
		let currentState: WhisperingRecordingState = 'RECORDING';
		let tauriUnlisten: Promise<UnlistenFn> | null = null;

		const notify = (state: WhisperingRecordingState) => {
			// Idempotent: same-state notifications collapse to a no-op. Rust
			// emits 'recorder:state-changed' IDLE from `stop_recording`, then
			// our explicit `teardown()` also notifies IDLE; without this
			// guard we'd fire the handler twice for one transition.
			if (currentState === state) return;
			currentState = state;
			for (const handler of subscribers) handler(state);
		};

		const ensureTauriListener = () => {
			if (tauriUnlisten) return;
			// Rust emits 'recorder:state-changed' from every mutation path
			// (see src-tauri/src/recorder/commands.rs). Forward to subscribers
			// so Rust-initiated transitions (future auto-stop, device
			// disconnect) reach the UI.
			tauriUnlisten = listen<WhisperingRecordingState>(
				'recorder:state-changed',
				(event) => notify(event.payload),
			);
		};

		// Takes `session` as an argument rather than closing over the const
		// declared below. Both work because teardown only runs from
		// stop/cancel handlers (which can only fire after `session` is
		// bound), but the explicit argument keeps the function TDZ-safe if a
		// future caller invokes teardown from a path declared above the
		// `session = ...` initializer.
		const teardown = (session: RecordingSession) => {
			if (activeSession === session) activeSession = null;
			if (tauriUnlisten) {
				void tauriUnlisten.then((unlisten) => unlisten());
				tauriUnlisten = null;
			}
			notify('IDLE');
		};

		const session = {
			recordingId,

			stop: async ({ sendStatus }) => {
				sendStatus({
					title: '⏸️ Saving recording',
					description: 'Writing the WAV artifact to disk...',
				});
				const { data: artifact, error: stopRecordingError } =
					await commands.stopRecording();
				if (stopRecordingError !== null) {
					const { error: closeError } = await commands.closeRecordingSession();
					if (closeError !== null)
						log.error(RecorderError.StopFailed({ cause: closeError }));
					teardown(session);
					return RecorderError.StopFailed({ cause: stopRecordingError });
				}

				// Rust's `stop_recording` returns the artifact handle but does
				// not close the worker; we still own the cpal stream and the
				// worker thread. Send `close_recording_session` so Rust can
				// join the worker and free the stream.
				sendStatus({
					title: '🔄 Closing Session',
					description: 'Cleaning up recording resources...',
				});
				const { error: closeError } = await commands.closeRecordingSession();
				if (closeError !== null)
					log.error(RecorderError.StopFailed({ cause: closeError }));
				teardown(session);

				return Ok({ kind: 'artifact', artifact });
			},

			cancel: async ({ sendStatus }) => {
				sendStatus({
					title: '🛑 Cancelling',
					description:
						'Safely stopping your recording and cleaning up resources...',
				});

				// cancel_recording on the Rust side discards the in-flight
				// samples and tears down the session worker. One round trip.
				const { error: cancelError } = await commands.cancelRecording();
				if (cancelError !== null) {
					sendStatus({
						title: '❌ Cancel Failed',
						description:
							'We hit a problem cancelling; continuing cleanup anyway...',
					});
				}

				teardown(session);
				return Ok({ status: 'cancelled' });
			},

			subscribe(handler) {
				ensureTauriListener();
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
			// If we still hold the in-memory pointer, prefer it; otherwise
			// probe Rust in case a recording session outlived a JS reload.
			if (activeSession) return Ok(activeSession);

			const { data: liveRecordingId, error: getIdError } =
				await commands.getCurrentRecordingId();
			if (getIdError !== null) {
				return RecorderError.GetStateFailed({ cause: getIdError });
			}
			if (!liveRecordingId) return Ok(null);

			const rehydrated = buildSession(liveRecordingId);
			activeSession = rehydrated;
			return Ok(rehydrated);
		},

		enumerateDevices,

		startRecording: async (
			{ selectedDeviceId, recordingId, sampleRate }: CpalRecordingParams,
			{ sendStatus },
		) => {
			sendStatus({
				title: '🎙️ Checking microphone access',
				description: 'Your system may ask you to allow microphone access.',
			});
			const { error: permissionError } = await requestMicrophonePermission();
			if (permissionError) return Err(permissionError);

			const { data: devices, error: enumerateError } = await enumerateDevices();
			if (enumerateError !== null) return Err(enumerateError);

			const deviceIds = devices.map((d) => d.id);
			const fallbackDeviceId = deviceIds.at(0);
			if (!fallbackDeviceId) {
				return RecorderError.NoDevice({
					message: selectedDeviceId
						? "We couldn't find the selected microphone. Make sure it's connected and try again!"
						: "We couldn't find any microphones. Make sure they're connected and try again!",
				});
			}

			const deviceOutcome: DeviceAcquisitionOutcome = (() => {
				if (!selectedDeviceId) {
					sendStatus({
						title: '🔍 No Device Selected',
						description:
							"No worries! We'll find the best microphone for you automatically...",
					});
					return {
						outcome: 'fallback',
						reason: 'no-device-selected',
						deviceId: fallbackDeviceId,
					};
				}

				if (deviceIds.includes(selectedDeviceId)) {
					return { outcome: 'success', deviceId: selectedDeviceId };
				}

				sendStatus({
					title: '⚠️ Finding a New Microphone',
					description:
						"That microphone isn't available. Let's try finding another one...",
				});
				return {
					outcome: 'fallback',
					reason: 'preferred-device-unavailable',
					deviceId: fallbackDeviceId,
				};
			})();

			const deviceIdentifier = deviceOutcome.deviceId;

			sendStatus({
				title: '🎤 Setting Up',
				description:
					'Initializing your recording session and checking microphone access...',
			});

			const sampleRateNum = sampleRate ? Number.parseInt(sampleRate, 10) : null;

			const { error: initRecordingSessionError } =
				await commands.initRecordingSession(
					deviceIdentifier,
					recordingId,
					sampleRateNum,
				);
			if (initRecordingSessionError !== null)
				return (
					categorizeRecorderError(initRecordingSessionError) ??
					RecorderError.InitFailed({
						cause: initRecordingSessionError,
					})
				);

			sendStatus({
				title: '🎙️ Starting Recording',
				description:
					'Recording session initialized, now starting to capture audio...',
			});
			const { error: startRecordingError } = await commands.startRecording();
			if (startRecordingError !== null)
				return (
					categorizeRecorderError(startRecordingError) ??
					RecorderError.StartFailed({ cause: startRecordingError })
				);

			const session = buildSession(recordingId);
			activeSession = session;
			return Ok({ session, deviceAcquisition: deviceOutcome });
		},
	} satisfies RecorderService<CpalRecordingParams>;
}

export const ManualRecorderLive =
	createCpalRecorder() satisfies RecorderService<CpalRecordingParams>;
