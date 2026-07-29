/**
 * @fileoverview Every way an Epicenter capability can decline.
 *
 * An app never constructs one of these, so only the types are public. What an
 * app does is read `error.name`, and each operation below declares exactly the
 * names it can produce.
 *
 * Two of them are about the environment rather than the capability.
 * `HostUnavailable` means the code is running somewhere Epicenter is not: an
 * ordinary browser tab, a test, a server render. `CapabilityUnavailable` means
 * Epicenter is there and refused to route the call at all, which is a wiring
 * fact (this window was not granted the operation) rather than something a user
 * can resolve. Both exist so an app can hold one handle everywhere instead of
 * checking for a platform before every call.
 *
 * What is deliberately not here: a variant for a programming bug. An unexpected
 * rejection becomes `RecordingFailed` or `TranscriptionFailed` with its `cause`
 * attached, never an "unavailable". Unavailability is a claim about the system;
 * making it the landing place for anything unrecognized would make the claim
 * worthless.
 */

import type {
	NonconformingRowError,
	NonconformingValueError,
} from '@epicenter/lens';
import {
	defineErrors,
	extractErrorMessage,
	type InferError,
	type InferErrors,
} from 'wellcrafted/error';

/** @internal Environment failures shared by every capability. */
export const HostErrors = defineErrors({
	/**
	 * No Epicenter host is present. The same call in an installed Epicenter app
	 * would have reached the host.
	 */
	HostUnavailable: ({ operation }: { operation: string }) => ({
		message: `Epicenter is not available here, so '${operation}' could not run. This capability needs the Epicenter desktop host.`,
		operation,
	}),
	/**
	 * Epicenter is present but refused to route the call. The window this app
	 * runs in was not granted the operation, so no user action resolves it: the
	 * host build has to grant it.
	 */
	CapabilityUnavailable: ({
		operation,
		cause,
	}: {
		operation: string;
		cause: unknown;
	}) => ({
		message: `Epicenter refused '${operation}' for this window: ${extractErrorMessage(cause)}`,
		operation,
		cause,
	}),
});

export type HostError = InferErrors<typeof HostErrors>;
export type HostUnavailable = InferError<typeof HostErrors.HostUnavailable>;
export type CapabilityUnavailable = InferError<
	typeof HostErrors.CapabilityUnavailable
>;

/** @internal Recording failures. */
export const RecordingErrors = defineErrors({
	/**
	 * The operating system refused microphone access. The grant belongs to the
	 * Epicenter application, not to this app, so the fix is in system settings.
	 */
	MicrophoneAccessDenied: ({ cause }: { cause: string }) => ({
		message: `Epicenter could not open the microphone because access is denied: ${cause}`,
		cause,
	}),
	/** No usable microphone: none is connected, or the default one vanished. */
	NoMicrophone: ({ cause }: { cause: string }) => ({
		message: `No microphone is available to record from: ${cause}`,
		cause,
	}),
	/**
	 * Another window already holds Epicenter's one recorder. It stays held until
	 * its owner stops or cancels it, so this is a wait, not a retry loop.
	 */
	RecorderBusy: ({ cause }: { cause: string }) => ({
		message: `Epicenter is already recording for another window: ${cause}`,
		cause,
	}),
	/**
	 * The id does not name a recording this app can end: it was already stopped
	 * or cancelled, or it belongs to another window. Expected rather than
	 * exceptional, which is what makes stopping twice a clean typed no-op.
	 */
	NoSuchRecording: ({
		audioBlobId,
		cause,
	}: {
		audioBlobId: string;
		cause: string;
	}) => ({
		message: `Recording '${audioBlobId}' is not this app's to end: ${cause}`,
		audioBlobId,
		cause,
	}),
	/** The recording operation failed for a reason an app cannot act on. */
	RecordingFailed: ({
		operation,
		cause,
	}: {
		operation: string;
		cause: unknown;
	}) => ({
		message: `Epicenter could not complete '${operation}': ${extractErrorMessage(cause)}`,
		operation,
		cause,
	}),
});

export type MicrophoneAccessDenied = InferError<
	typeof RecordingErrors.MicrophoneAccessDenied
>;
export type NoMicrophone = InferError<typeof RecordingErrors.NoMicrophone>;
export type RecorderBusy = InferError<typeof RecordingErrors.RecorderBusy>;
export type NoSuchRecording = InferError<
	typeof RecordingErrors.NoSuchRecording
>;
export type RecordingFailed = InferError<
	typeof RecordingErrors.RecordingFailed
>;

/** @internal Transcription failures. */
export const TranscriptionErrors = defineErrors({
	/**
	 * The local transcription route cannot run: no model is active on this
	 * device, or the active one is not here. `reason` distinguishes them; neither
	 * names a model, because choosing one belongs to Epicenter Home.
	 */
	TranscriptionUnavailable: ({
		reason,
		message,
	}: {
		reason: 'no-active-model' | 'active-model-unavailable';
		/**
		 * The host's own sentence, passed through rather than rewritten. It is
		 * already written for a person and it names no model, and this client is
		 * not better placed than the host to say why the route cannot run.
		 */
		message: string;
	}) => ({
		message,
		reason,
	}),
	/** The recording's audio could not be read back. */
	AudioUnreadable: ({
		audioBlobId,
		cause,
	}: {
		audioBlobId: string;
		cause: string;
	}) => ({
		message: `Epicenter could not read the audio for '${audioBlobId}': ${cause}`,
		audioBlobId,
		cause,
	}),
	/**
	 * A model was resolvable but would not load. Kept apart from
	 * `TranscriptionUnavailable` so a broken install does not read to the user as
	 * "you have not set this up yet".
	 */
	ModelLoadFailed: ({ cause }: { cause: string }) => ({
		message: `Epicenter could not load the active transcription model: ${cause}`,
		cause,
	}),
	/** Transcription ran and failed. */
	TranscriptionFailed: ({
		operation,
		cause,
	}: {
		operation: string;
		cause: unknown;
	}) => ({
		message: `Epicenter could not complete '${operation}': ${extractErrorMessage(cause)}`,
		operation,
		cause,
	}),
});

export type TranscriptionUnavailable = InferError<
	typeof TranscriptionErrors.TranscriptionUnavailable
>;
export type AudioUnreadable = InferError<
	typeof TranscriptionErrors.AudioUnreadable
>;
export type ModelLoadFailed = InferError<
	typeof TranscriptionErrors.ModelLoadFailed
>;
export type TranscriptionFailed = InferError<
	typeof TranscriptionErrors.TranscriptionFailed
>;

// ── What each operation can actually return ───────────────────────────
//
// Narrower than "every recording failure", because a caller that has to
// consider `RecorderBusy` when cancelling learns nothing from the type. The
// narrowing is enforced rather than asserted: each operation maps only the host
// failures it expects and folds anything else into its `*Failed` variant.

export type StartRecordingError =
	| HostError
	| MicrophoneAccessDenied
	| NoMicrophone
	| RecorderBusy
	| RecordingFailed;

export type CurrentRecordingError = HostError | RecordingFailed;

export type ResolveRecordingError =
	| HostError
	| NoSuchRecording
	| RecordingFailed;

export type ObserveRecordingError = HostError | RecordingFailed;

export type TranscriptionCapabilitiesError =
	| HostError
	| TranscriptionUnavailable
	| TranscriptionFailed;

export type TranscribeError =
	| HostError
	| TranscriptionUnavailable
	| AudioUnreadable
	| ModelLoadFailed
	| TranscriptionFailed;

/** @internal Structured data failures. */
export const DataErrors = defineErrors({
	/**
	 * Epicenter is here, but its data runtime is not serving. The most common
	 * cause is a host generation that has no store open yet; a retry after the
	 * host settles is the recovery, and there is nothing an app can fix.
	 */
	DataUnavailable: ({ message }: { message: string }) => ({ message }),
	/**
	 * A data operation ran and failed. Invalid patches, unknown fields, refused
	 * writes, and transport failures all land here with their cause attached,
	 * because none of them is a claim that data is unavailable.
	 */
	DataFailed: ({
		operation,
		cause,
	}: {
		operation: string;
		cause: unknown;
	}) => ({
		message: `Epicenter could not complete '${operation}': ${extractErrorMessage(cause)}`,
		operation,
		cause,
	}),
});

export type DataUnavailable = InferError<typeof DataErrors.DataUnavailable>;
export type DataFailed = InferError<typeof DataErrors.DataFailed>;

/** What binding a Lens can decline with. */
export type BindDataError = HostError | DataUnavailable | DataFailed;

/** What a write, a delete, or a traversal can decline with. */
export type DataOperationError = DataUnavailable | DataFailed;

/**
 * What a read can decline with.
 *
 * Wider than a write, by exactly the two failures that are about the stored
 * value rather than the operation: a row or value that the app's current Lens
 * cannot interpret. Those are reported rather than repaired, and they carry the
 * raw JSON so an app can decide what to do about its own data.
 */
export type DataReadError =
	| DataOperationError
	| NonconformingRowError
	| NonconformingValueError;
