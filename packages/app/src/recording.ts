/**
 * @fileoverview `epicenter.recording`: capture audio through Epicenter's one
 * host recorder.
 *
 * The host owns the recorder, and it holds exactly one recording at a time. An
 * app does not open a session, hold a lease, or receive a recording object with
 * methods on it: a recording is a blob id that `start` hands back, and every
 * later call names that id. That mirrors the host exactly, which is the point.
 * A recording survives a page reload, because reloading does not destroy the
 * window that owns it, and `current` is how an app finds it again.
 *
 * There is no device list and no device picker here. `start` records from the
 * system default microphone and reports which one that turned out to be.
 *
 * Capture can end without anyone asking: a microphone is unplugged, access is
 * withdrawn, the disk fills. When that happens the *recording* does not end.
 * It keeps its audio and stays this app's to resolve, and `stop` still
 * publishes whatever was captured before the microphone died. {@link
 * RecordingNamespace.onEnded} is how an app hears about it as it happens;
 * `current().endedReason` is how an app that was not listening finds out. The
 * second one is the durable path, so an app that only ever calls `current` is
 * still correct, just less responsive.
 */

import {
	type ObserveRecordingError,
	type ResolveRecordingError,
	type CurrentRecordingError,
	RecordingErrors,
	type StartRecordingError,
} from './errors.js';
import {
	callHost,
	isHostRejection,
	observeHost,
	taggedMessage,
	taggedName,
} from './host.js';
import {
	COMMANDS,
	RECORDING_ENDED_EVENT,
	type WireHostRecording,
	type WireRecordingEndedEvent,
	type WireStoppedRecording,
} from './protocol.js';
import { Err, Ok, type Result } from 'wellcrafted/result';

/** Why a capture ended on its own, and what the person can do about it. */
export type RecordingEndedReason =
	/** The microphone went away. Reconnect it, or connect another one. */
	| 'deviceDisconnected'
	/** The operating system withdrew microphone access. Grant it again. */
	| 'permissionRevoked'
	/** The capture stream failed for a reason Epicenter cannot make actionable. */
	| 'streamFailed'
	/**
	 * The audio could not be written any further: the disk filled, its volume
	 * went away, or the recording hit the longest a WAV file can describe.
	 */
	| 'storageFailed';

/** A recording Epicenter is holding for this app. */
export type Recording = {
	/**
	 * Names this recording everywhere, and names its audio once `stop` publishes
	 * it. `transcription.transcribe` takes exactly this id.
	 */
	audioBlobId: string;
	/** The microphone that actually opened, so an app can say which one it is using. */
	microphone: string;
	/**
	 * `null` while audio is still being captured. Otherwise the reason capture
	 * ended on its own. Either way the recording is still this app's to `stop`
	 * or `cancel`, and stopping an ended recording publishes what it captured.
	 */
	endedReason: RecordingEndedReason | null;
};

/** The audio a `stop` published. */
export type PublishedRecording = {
	/** The recording's id, now naming durable audio. */
	audioBlobId: string;
	/** How much audio the published file actually holds. */
	durationMs: number;
	/** The published file's exact size in bytes. */
	byteLength: number;
};

/** A capture that ended without anyone asking. */
export type RecordingEnded = {
	audioBlobId: string;
	reason: RecordingEndedReason;
};

/** Ends a subscription. Calling it more than once is harmless. */
export type Unsubscribe = () => void;

export type RecordingNamespace = {
	/**
	 * Start recording from the system default microphone.
	 *
	 * Fails with `RecorderBusy` when another window already holds the recorder;
	 * that recording is somebody else's to resolve, so this is a wait rather
	 * than something to retry in a loop.
	 */
	start(): Promise<Result<Recording, StartRecordingError>>;
	/**
	 * The recording this app currently holds, or `null`.
	 *
	 * A pure read, and the answer has the same shape `start` returns, so a
	 * recording recovered after a reload is not a different kind of thing from a
	 * fresh one. Reading `endedReason` here is the durable way to learn that a
	 * capture died, including one that died while this app was not running.
	 */
	current(): Promise<Result<Recording | null, CurrentRecordingError>>;
	/**
	 * Stop the recording and publish its audio.
	 *
	 * The only way audio is ever published. It works on either side of the
	 * capture ending: a recording whose microphone died still publishes what it
	 * captured before it did.
	 */
	stop(
		audioBlobId: string,
	): Promise<Result<PublishedRecording, ResolveRecordingError>>;
	/**
	 * Discard the recording and its audio. Nothing is ever published under this
	 * id afterwards.
	 */
	cancel(audioBlobId: string): Promise<Result<void, ResolveRecordingError>>;
	/**
	 * Be told when a capture ends without anyone asking.
	 *
	 * Subscribe once, before starting anything: the subscription belongs to the
	 * app rather than to one recording, so there is no window between starting a
	 * recording and being able to hear about it. Delivery is best effort by
	 * design. An app that misses one finds the same ended recording through
	 * {@link RecordingNamespace.current}, which is why nothing is queued or
	 * replayed.
	 */
	onEnded(
		handler: (ended: RecordingEnded) => void,
	): Promise<Result<Unsubscribe, ObserveRecordingError>>;
};

/**
 * Both `start` and `current` answer with the host's acquisition union, whose
 * arms differ only for a caller that named a device. This one never does, so
 * only the microphone's name survives.
 */
function toRecording(wire: WireHostRecording): Recording {
	return {
		audioBlobId: wire.audioBlobId,
		microphone: wire.device.deviceId,
		endedReason: wire.endedReason,
	};
}

export const recording: RecordingNamespace = {
	async start() {
		const operation = 'recording.start';
		// No device identifier, ever: this client records from the system
		// default and reports what opened.
		const { data, error } = await callHost<WireHostRecording>(
			operation,
			COMMANDS.startRecording,
			{ deviceIdentifier: null },
		);
		if (error) {
			if (!isHostRejection(error)) return Err(error);
			const cause = taggedMessage(error.domain);
			switch (taggedName(error.domain)) {
				case 'PermissionDenied':
					return RecordingErrors.MicrophoneAccessDenied({ cause });
				case 'NoInputDevice':
					return RecordingErrors.NoMicrophone({ cause });
				case 'Busy':
					return RecordingErrors.RecorderBusy({ cause });
				default:
					return RecordingErrors.RecordingFailed({
						operation,
						cause: error.domain,
					});
			}
		}
		return Ok(toRecording(data));
	},

	async current() {
		const operation = 'recording.current';
		const { data, error } = await callHost<WireHostRecording | null>(
			operation,
			COMMANDS.currentRecording,
		);
		if (error) {
			if (!isHostRejection(error)) return Err(error);
			return RecordingErrors.RecordingFailed({
				operation,
				cause: error.domain,
			});
		}
		return Ok(data === null ? null : toRecording(data));
	},

	async stop(audioBlobId) {
		const operation = 'recording.stop';
		const { data, error } = await callHost<WireStoppedRecording>(
			operation,
			COMMANDS.stopRecording,
			{ audioBlobId },
		);
		if (error) return resolveFailure(operation, audioBlobId, error);
		return Ok({
			audioBlobId: data.audioBlobId,
			durationMs: data.durationMs,
			byteLength: data.byteLength,
		});
	},

	async cancel(audioBlobId) {
		const operation = 'recording.cancel';
		const { error } = await callHost<null>(
			operation,
			COMMANDS.cancelRecording,
			{ audioBlobId },
		);
		if (error) return resolveFailure(operation, audioBlobId, error);
		return Ok(undefined);
	},

	async onEnded(handler) {
		const operation = 'recording.onEnded';
		const { data, error } = await observeHost<WireRecordingEndedEvent>(
			operation,
			RECORDING_ENDED_EVENT,
			({ audioBlobId, reason }) => handler({ audioBlobId, reason }),
		);
		if (error) {
			if (!isHostRejection(error)) return Err(error);
			return RecordingErrors.RecordingFailed({
				operation,
				cause: error.domain,
			});
		}
		return Ok(data);
	},
};

/**
 * `stop` and `cancel` fail the same way, because they ask the same question:
 * is this id still this app's to end?
 */
function resolveFailure(
	operation: string,
	audioBlobId: string,
	error: Parameters<typeof isHostRejection>[0],
): Err<ResolveRecordingError> {
	if (!isHostRejection(error)) return Err(error);
	if (taggedName(error.domain) === 'NotRecording') {
		return RecordingErrors.NoSuchRecording({
			audioBlobId,
			cause: taggedMessage(error.domain),
		});
	}
	return RecordingErrors.RecordingFailed({ operation, cause: error.domain });
}
