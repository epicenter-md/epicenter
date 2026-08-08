/**
 * @fileoverview The public Epicenter client.
 *
 * ```ts
 * import { epicenter } from '@epicenter/app';
 *
 * const { data: recording, error } = await epicenter.recording.start();
 * ```
 *
 * One handle, one shape. An app imports it, uses it, and never asks which
 * platform it is on: whether a capability can run right now is a typed
 * `Result`, not a missing namespace or an optional method.
 *
 * There is no browser-tab mode. An installed app is served by an Epicenter host
 * and runs nowhere else, so the host is present by construction and this client
 * neither probes for it nor carries a variant saying it is missing. A window
 * that was not granted an operation still answers `CapabilityUnavailable`,
 * because that is a build fact rather than an environment one.
 *
 * There is no `openEpicenter()`. The handle owns no connection, no session, and
 * no configuration, so there is nothing an opener could do except make every
 * app write a line that does nothing.
 *
 * Three capabilities today: {@link EpicenterHandle.recording},
 * {@link EpicenterHandle.transcription}, and {@link EpicenterHandle.data}.
 * Blobs are not here yet.
 *
 * `data` is the one capability with something to wait for. Recording and
 * transcription are thin calls over host commands, while a bound Lens promises
 * to report when its data may be stale, and that promise is only keepable once
 * the document's shared observation carrier exists. So `data.bind(lens)` is
 * awaited without introducing any handle-wide session.
 */

import { type DataNamespace, data } from './data.js';
import { type RecordingNamespace, recording } from './recording.js';
import { type TranscriptionNamespace, transcription } from './transcription.js';

export type EpicenterHandle = {
	/** Capture audio through Epicenter's host recorder. */
	recording: RecordingNamespace;
	/** Turn a published recording into text on Epicenter's transcription route. */
	transcription: TranscriptionNamespace;
	/** Read and write structured data through a Lens this app declares. */
	data: DataNamespace;
};

/** The one Epicenter handle. */
export const epicenter: EpicenterHandle = { data, recording, transcription };

export type { TableInvalidation } from '@epicenter/lens/legacy';
export type {
	BoundData,
	DataNamespace,
	TableEntry,
	TableHandle,
	TableScan,
} from './data.js';
export type {
	AudioUnreadable,
	BindDataError,
	CapabilityUnavailable,
	CurrentRecordingError,
	DataFailed,
	DataOperationError,
	DataReadError,
	DataUnavailable,
	HostError,
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
