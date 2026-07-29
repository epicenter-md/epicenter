/**
 * @fileoverview The public Epicenter client.
 *
 * ```ts
 * import { epicenter } from '@epicenter/app';
 *
 * const { data: recording, error } = await epicenter.recording.start();
 * ```
 *
 * One handle, the same shape everywhere. An app imports it, uses it, and never
 * asks which platform it is on: whether a capability can run right now is a
 * typed `Result`, not a missing namespace or an optional method. In an ordinary
 * browser tab every fallible operation answers `HostUnavailable`, which is a
 * value an app can render rather than a crash it has to guard. The one
 * operation with no outcome, `transcription.prewarm()`, keeps its promise by
 * doing nothing there, as it does anywhere.
 *
 * There is no `openEpicenter()`. The handle owns no connection, no session, and
 * no configuration, so there is nothing an opener could do except make every
 * app write a line that does nothing.
 *
 * Two capabilities today: {@link EpicenterHandle.recording} and
 * {@link EpicenterHandle.transcription}. Structured data and blobs are not
 * here yet.
 */

import { type RecordingNamespace, recording } from './recording.js';
import { type TranscriptionNamespace, transcription } from './transcription.js';

export type EpicenterHandle = {
	/** Capture audio through Epicenter's host recorder. */
	recording: RecordingNamespace;
	/** Turn a published recording into text on Epicenter's transcription route. */
	transcription: TranscriptionNamespace;
};

/** The one Epicenter handle. */
export const epicenter: EpicenterHandle = { recording, transcription };

export type {
	AudioUnreadable,
	CapabilityUnavailable,
	CurrentRecordingError,
	HostError,
	HostUnavailable,
	MicrophoneAccessDenied,
	ModelLoadFailed,
	NoMicrophone,
	NoSuchRecording,
	ObserveRecordingError,
	RecorderBusy,
	RecordingFailed,
	ResolveRecordingError,
	StartRecordingError,
	TranscribeError,
	TranscriptionCapabilitiesError,
	TranscriptionFailed,
	TranscriptionUnavailable,
} from './errors.js';
export type {
	PublishedRecording,
	Recording,
	RecordingEnded,
	RecordingEndedReason,
	RecordingNamespace,
	Unsubscribe,
} from './recording.js';
export type {
	AppliedHints,
	Transcript,
	TranscriptionCapabilities,
	TranscriptionHints,
	TranscriptionNamespace,
} from './transcription.js';
