import type {
	BlobAlreadyExists,
	BlobId,
	BlobNotFound,
	BlobStoreFailed,
} from '@epicenter/blobs';
import type {
	Device,
	DeviceAcquisitionOutcome,
	DeviceIdentifier,
} from '@epicenter/recorder';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

/**
 * Recorder lifecycle state. A plain union: the states are never validated at
 * runtime, only used as compile-time types. Emitted by
 * {@link RecordingSession.subscribe}.
 */
export type RecordingState = 'IDLE' | 'RECORDING';

export const RecorderError = defineErrors({
	EnumerateDevices: ({ cause }: { cause: unknown }) => ({
		message: `Failed to enumerate recording devices: ${extractErrorMessage(cause)}`,
		cause,
	}),
	MicrophonePermissionDenied: ({ cause }: { cause?: unknown } = {}) => ({
		message:
			'Microphone access was denied. Please grant microphone permission in your system or browser settings and try again.',
		cause,
	}),
	NoInputDevice: ({ cause }: { cause?: unknown } = {}) => ({
		message:
			"We couldn't find any microphone to record from. Please connect a microphone and try again.",
		cause,
	}),
	InitFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to initialize the audio recorder: ${extractErrorMessage(cause)}`,
		cause,
	}),
	StartFailed: ({ cause }: { cause: unknown }) => ({
		message: `Unable to start recording: ${extractErrorMessage(cause)}`,
		cause,
	}),
	StopFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to stop recording: ${extractErrorMessage(cause)}`,
		cause,
	}),
	CancelFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to cancel recording: ${extractErrorMessage(cause)}`,
		cause,
	}),
	/**
	 * Something else already holds the recorder. On desktop there is one host
	 * recorder shared by every window, so this can mean another application
	 * entirely, which is why the message does not assume it was this app.
	 */
	AlreadyRecording: ({ cause }: { cause?: unknown } = {}) => ({
		message:
			'Something is already recording. Stop that recording before starting a new one.',
		cause,
	}),
	/**
	 * The recording being stopped or cancelled is not this window's to end: it
	 * already finished, it is not the live one, or another window owns it.
	 *
	 * Not necessarily a failure. A push-to-talk release that lands after its
	 * recording was already supplanted sees this, and the right response is to
	 * do nothing.
	 */
	NoActiveRecording: ({ cause }: { cause?: unknown } = {}) => ({
		message: 'That recording has already ended.',
		cause,
	}),
	StreamAcquisition: ({ cause }: { cause: unknown }) => ({
		message: `Failed to acquire recording stream: ${extractErrorMessage(cause)}`,
		cause,
	}),
	GetStateFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to get recorder state: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type RecorderError = InferErrors<typeof RecorderError>;

/**
 * Settings-derived parameters shared across manual recorder implementations.
 *
 * This is config resolved from persisted settings (device, encoding). Live
 * caller callbacks are not config and travel separately in
 * {@link RecordingCallbacks}.
 *
 * The blob id is deliberately absent: the implementation that owns the capture
 * mints it, and the caller learns it from {@link RecordingSession.audioBlobId}.
 * On desktop that mint happens in Rust, because ownership of the one host
 * recorder is decided there and an id asserted by a caller could not carry it.
 */
export type BaseRecordingParams = {
	selectedDeviceId: DeviceIdentifier | null;
};

/**
 * Live callbacks supplied by the caller at the moment of starting, kept
 * separate from the settings-derived params config (a {@link BaseRecordingParams}
 * extension such as {@link NavigatorRecordingParams}) because a callback is not
 * a persisted setting. They are passed alongside the resolved params, never
 * merged into them.
 */
export type RecordingCallbacks = {
	/**
	 * Sink for live mic loudness (raw RMS, ~0 silent to ~0.3 loud speech),
	 * called continuously while recording so the caller can draw a meter.
	 *
	 * The browser recorder taps its MediaStream to drive this. The native
	 * recorder cannot: the PCM never leaves Rust, so the host computes the level
	 * and emits it to the window that owns the recording, and the Tauri
	 * implementation forwards that event into this sink. Either way the caller
	 * sees one quantity from one callback.
	 */
	onLevel: (level: number) => void;
};

/**
 * Browser (MediaRecorder) recording parameters.
 */
export type NavigatorRecordingParams = BaseRecordingParams & {
	bitrateKbps: string;
};

/**
 * Finalized local audio. Every platform has committed bytes before returning,
 * so every field is known: `durationMs` is the host's exact sample count on
 * desktop and the measured capture window in the browser, never absent.
 */
export type RecorderStopResult = {
	audioBlobId: BlobId;
	durationMs: number;
	byteLength: number;
};

export type RecorderStopError =
	| RecorderError
	| BlobAlreadyExists
	| BlobNotFound
	| BlobStoreFailed;

/**
 * A live recording session returned by the recorder implementation that started it.
 *
 * The `RecordingSession` is the unit of lifecycle: it owns its own teardown and
 * exposes per-session state changes.
 *
 * The `subscribe` handler is invoked synchronously with the current state on
 * subscribe (so callers don't have to mirror "I just started" themselves),
 * then again whenever the session transitions, ending with 'IDLE' on
 * stop/cancel.
 */
export type RecordingSession = {
	readonly audioBlobId: BlobId;
	stop(): Promise<Result<RecorderStopResult, RecorderStopError>>;
	/**
	 * Cancel the in-flight recording and discard it. Success carries no payload
	 * (a live session can only resolve to "cancelled"); the caller's wrapper is
	 * where the `cancelled` vs `no-recording` distinction is made.
	 */
	cancel(): Promise<Result<void, RecorderError>>;
	subscribe(handler: (state: RecordingState) => void): () => void;
};

/**
 * Factory for recording sessions. Services no longer carry mutable
 * start/stop state directly; instead `startRecording` returns a RecordingSession
 * whose methods are bound to the implementation that produced it.
 */
export type RecorderService<RecordingParams extends BaseRecordingParams> = {
	/**
	 * Recover a RecordingSession that may have survived a JS reload.
	 *
	 * Native sessions can outlive a JS reload because the host process keeps the
	 * stream; browser sessions cannot survive a reload and return null.
	 *
	 * Returns the live RecordingSession owned by this implementation, or null if none.
	 */
	resumeActiveSession(): Promise<
		Result<RecordingSession | null, RecorderError>
	>;

	/**
	 * Enumerate available recording devices with their labels and identifiers
	 */
	enumerateDevices(): Promise<Result<Device[], RecorderError>>;

	/**
	 * Start a new recording session, returning the RecordingSession handle along
	 * with the device acquisition outcome. The caller holds the RecordingSession
	 * and uses its `stop`/`cancel`/`subscribe` for the rest of the session.
	 *
	 * `params` is settings-derived config; `callbacks` are the caller's live
	 * sinks.
	 */
	startRecording(
		params: RecordingParams,
		callbacks: RecordingCallbacks,
	): Promise<
		Result<
			{
				session: RecordingSession;
				deviceAcquisition: DeviceAcquisitionOutcome;
			},
			RecorderError
		>
	>;
};
