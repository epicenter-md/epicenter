/**
 * Type-level smoke tests for the boundary adapter.
 *
 * These assertions never run at value-level; they exist so a regression in
 * the `Wrap<F>` mapper or in `tauri-specta`'s output surfaces as a
 * `svelte-check` / `tsc` failure at the type level.
 */

import type { Result } from 'wellcrafted/result';
import type {
	commands,
	DictationCapability,
	IpcRecorderError,
	LocalTranscriptionReadiness,
	StoppedRecording,
	TranscriptionError,
	TranscriptionHints,
	TranscriptionOutcome,
} from './commands';
import type {
	DictationCapability as SharedDictationCapability,
	IpcRecorderError as SharedIpcRecorderError,
	LocalTranscriptionReadiness as SharedLocalTranscriptionReadiness,
	TranscriptionError as SharedTranscriptionError,
	TranscriptionHints as SharedTranscriptionHints,
	TranscriptionOutcome as SharedTranscriptionOutcome,
} from './commands.types';

// Helper: a no-op assertion that two types are equal.
type Expect<T extends true> = T;
type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
		? true
		: false;

// Browser-safe copies of generated contracts must move in lockstep with the
// native bindings without importing their runtime module into the hosted SPA.
type _SharedContracts = Expect<
	Equal<
		[
			SharedDictationCapability,
			SharedIpcRecorderError,
			SharedLocalTranscriptionReadiness,
			SharedTranscriptionError,
			SharedTranscriptionHints,
			SharedTranscriptionOutcome,
		],
		[
			DictationCapability,
			IpcRecorderError,
			LocalTranscriptionReadiness,
			TranscriptionError,
			TranscriptionHints,
			TranscriptionOutcome,
		]
	>
>;

// The whole recording surface, pinned.
//
// Each of these commands takes an injected `tauri::WebviewWindow` in Rust, so
// the host knows which window is calling without the caller being able to say.
// Specta renders that parameter as nothing at all, and these argument
// assertions are the proof: if the injection ever started leaking into the
// generated signature, the arity here would stop matching.
//
// The errors are the structured `RecorderError` IPC enum, not bare strings, so
// the recorder boundary stays typed.

// start_recording: optional device and sample rate in, the host-minted blob id
// out. The caller does not supply an id, because the host owns which recording
// exists.
type _StartRecordingArgs = Expect<
	Equal<
		Parameters<typeof commands.startRecording>,
		[string | null, number | null]
	>
>;

type _StartRecording = Expect<
	Equal<
		ReturnType<typeof commands.startRecording>,
		Promise<Result<string, IpcRecorderError>>
	>
>;

// stop_recording: names the recording to end, and answers with the committed
// blob plus the host's exact duration and byte length. Neither is nullable,
// because a stop that returns at all has already published the file.
type _StopRecordingArgs = Expect<
	Equal<Parameters<typeof commands.stopRecording>, [string]>
>;

type _StopRecording = Expect<
	Equal<
		ReturnType<typeof commands.stopRecording>,
		Promise<Result<StoppedRecording, IpcRecorderError>>
	>
>;

type _StoppedRecordingShape = Expect<
	Equal<
		StoppedRecording,
		{ audioBlobId: string; durationMs: number; byteLength: number }
	>
>;

// cancel_recording: names the recording to burn, and produces nothing. The
// absence of a result type is the invariant: a cancel can never hand anyone a
// blob.
type _CancelRecordingArgs = Expect<
	Equal<Parameters<typeof commands.cancelRecording>, [string]>
>;

type _CancelRecording = Expect<
	Equal<
		ReturnType<typeof commands.cancelRecording>,
		Promise<Result<null, IpcRecorderError>>
	>
>;

// current_recording: takes nothing, because the only window it could be asked
// about is the one asking. That scoping lives in Rust with the injected window,
// which is why there is no label parameter here to get wrong.
type _CurrentRecordingArgs = Expect<
	Equal<Parameters<typeof commands.currentRecording>, []>
>;

type _CurrentRecording = Expect<
	Equal<
		ReturnType<typeof commands.currentRecording>,
		Promise<Result<string | null, IpcRecorderError>>
	>
>;

// pause_playback / resume_playback: infallible across IPC. A platform failure
// is logged in Rust and never surfaces as an error the frontend must handle, so
// these stay plain Promises with no Result wrap.
type _PausePlayback = Expect<
	Equal<ReturnType<typeof commands.pausePlayback>, Promise<string[]>>
>;

type _ResumePlayback = Expect<
	Equal<ReturnType<typeof commands.resumePlayback>, Promise<void>>
>;

// transcribe_recording: fallible, takes the blob id plus advisory hints, and
// answers with the text alongside the exact model that produced it. The absence
// of a model argument here is the ADR-0180 invariant expressed at the type
// level: an application cannot name a model, so it cannot change one.
type _TranscribeRecording = Expect<
	Equal<
		ReturnType<typeof commands.transcribeRecording>,
		Promise<Result<TranscriptionOutcome, TranscriptionError>>
	>
>;

type _TranscribeRecordingArgs = Expect<
	Equal<
		Parameters<typeof commands.transcribeRecording>,
		[string, TranscriptionHints]
	>
>;

// prewarm_model: takes nothing. It warms the active model, the same one
// transcribe will run, because there is only one.
type _PrewarmModelArgs = Expect<
	Equal<Parameters<typeof commands.prewarmModel>, []>
>;

// get_local_transcription_readiness: infallible and advisory. This is the whole
// application-facing read of the local route, and the type is the boundary:
// there is no model id, no name, and no inventory anywhere in it (ADR-0180).
type _GetLocalTranscriptionReadiness = Expect<
	Equal<
		ReturnType<typeof commands.getLocalTranscriptionReadiness>,
		Promise<LocalTranscriptionReadiness>
	>
>;

type _ReadinessShape = Expect<
	Equal<
		LocalTranscriptionReadiness,
		| { status: 'ready'; supportsPrompt: boolean; supportsLanguage: boolean }
		| {
				status: 'unavailable';
				reason: 'no-active-model' | 'active-model-unavailable';
				message: string;
		  }
	>
>;

// open_accessibility_settings: fallible, returns unit as null. Deliberately a
// bare-string error (tier 2): the frontend wraps it into one PermissionsError
// variant and only displays the message; it never branches on the cause.
type _OpenAccessibilitySettings = Expect<
	Equal<
		ReturnType<typeof commands.openAccessibilitySettings>,
		Promise<Result<null, string>>
	>
>;

// encode_recording_for_upload: hand-rolled, raw bytes success path. Error stays
// a bare string (tier 2): `tauri::ipc::Response` is not `specta::Type`, so this
// command lives outside the generated surface, and the frontend treats a
// failure as best-effort ("compression skipped"), never branching on it.
type _EncodeRecordingForUpload = Expect<
	Equal<
		ReturnType<typeof commands.encodeRecordingForUpload>,
		Promise<Result<ArrayBuffer, string>>
	>
>;

// TranscriptionHints is the per-call advisory input: language and prompt, and
// deliberately no model.
type _TranscriptionHintsShape = Expect<
	Equal<
		TranscriptionHints,
		{
			language?: string | null;
			initialPrompt?: string | null;
		}
	>
>;
