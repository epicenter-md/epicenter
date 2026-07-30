/**
 * @fileoverview The host commands this client speaks, and the shapes they carry.
 *
 * Written here rather than generated. The host's own generated bindings export
 * every command the Rust crate registers, and this package is a product
 * boundary: what an app may call is a smaller, deliberately chosen set. Naming
 * the seven commands by hand is what keeps that boundary a decision instead of
 * a side effect of what a generator happened to know.
 *
 * These declarations are the wire, not the public API. Everything below is
 * internal: `index.ts` decides what an app actually sees, and the two differ
 * wherever the honest application-facing shape differs from the transport one
 * (readiness becomes a `Result`, a device acquisition becomes one microphone
 * name, a recorder failure becomes a tagged error).
 *
 * Alignment with the host is proved, not assumed: `apps/epicenter` carries a
 * drift test that checks every command name and every field below against the
 * bindings its Rust crate generates.
 */

/** The commands an installed app may invoke. Nothing outside this list. */
export const COMMANDS = {
	startRecording: 'start_recording',
	stopRecording: 'stop_recording',
	cancelRecording: 'cancel_recording',
	currentRecording: 'current_recording',
	transcribeRecording: 'transcribe_recording',
	prewarmModel: 'prewarm_model',
	localTranscriptionReadiness: 'get_local_transcription_readiness',
} as const;

/** The one event the host pushes to a window that owns a recording. */
export const RECORDING_ENDED_EVENT = 'recording-ended-event';

/**
 * Which microphone a recording opened.
 *
 * Both arms carry the name of the device that actually recorded. This client
 * never names a device, so the host always reports the `fallback` arm with
 * `no-device-selected`, which says nothing an app can act on. Only the name
 * survives into the public shape.
 */
export type WireDeviceAcquisition =
	| { outcome: 'success'; deviceId: string }
	| { outcome: 'fallback'; reason: string; deviceId: string };

/** Why a capture ended without anyone asking it to. */
export type WireEndedReason =
	| 'deviceDisconnected'
	| 'permissionRevoked'
	| 'streamFailed'
	| 'storageFailed';

/** The one shape both `start_recording` and `current_recording` answer with. */
export type WireHostRecording = {
	audioBlobId: string;
	device: WireDeviceAcquisition;
	endedReason: WireEndedReason | null;
};

/** What `stop_recording` publishes. */
export type WireStoppedRecording = {
	audioBlobId: string;
	durationMs: number;
	byteLength: number;
};

/** The payload of {@link RECORDING_ENDED_EVENT}. */
export type WireRecordingEndedEvent = {
	audioBlobId: string;
	reason: WireEndedReason;
};

/** The recorder's tagged failures. */
export type WireRecorderError = {
	name:
		| 'PermissionDenied'
		| 'NoInputDevice'
		| 'Busy'
		| 'NotRecording'
		| 'Failed';
	message: string;
};

/** Why the local transcription route cannot run right now. */
export type WireUnavailableReason =
	| 'no-active-model'
	| 'active-model-unavailable';

/**
 * Whether the local route can run, and what it accepts.
 *
 * A tagged union on the wire because the host answers this read successfully
 * either way. The public surface turns it into a `Result`, which is the shape
 * ADR-0181 asks for: an unavailable route is a typed failure of the capability,
 * not a successful answer a caller has to remember to branch on.
 */
export type WireLocalTranscriptionReadiness =
	| { status: 'ready'; supportsPrompt: boolean; supportsLanguage: boolean }
	| {
			status: 'unavailable';
			reason: WireUnavailableReason;
			message: string;
	  };

/** The advisory hints a transcription may carry. Never a model. */
export type WireTranscriptionHints = {
	language?: string | null;
	initialPrompt?: string | null;
};

/** Which advisory hints the run actually applied. */
export type WireAppliedHints = {
	language: string | null;
	initialPrompt: boolean;
};

/** What a transcription produced. */
export type WireTranscriptionOutcome =
	| {
			outcome: 'transcribed';
			text: string;
			modelId: string;
			applied: WireAppliedHints;
	  }
	| { outcome: 'empty-audio' };

/** The transcription route's tagged failures. */
export type WireTranscriptionError =
	| { name: 'AudioReadError'; message: string }
	| {
			name: 'LocalRouteUnavailable';
			reason: WireUnavailableReason;
			message: string;
	  }
	| { name: 'ModelLoadError'; message: string }
	| { name: 'TranscriptionError'; message: string };
