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
	LocalTranscript,
	LocalTranscriptionReadiness,
	TranscriptionError,
	TranscriptionHints,
} from './commands';
import type {
	DictationCapability as SharedDictationCapability,
	IpcRecorderError as SharedIpcRecorderError,
	LocalTranscript as SharedLocalTranscript,
	LocalTranscriptionReadiness as SharedLocalTranscriptionReadiness,
	TranscriptionError as SharedTranscriptionError,
	TranscriptionHints as SharedTranscriptionHints,
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
			SharedLocalTranscript,
			SharedLocalTranscriptionReadiness,
			SharedTranscriptionError,
			SharedTranscriptionHints,
		],
		[
			DictationCapability,
			IpcRecorderError,
			LocalTranscript,
			LocalTranscriptionReadiness,
			TranscriptionError,
			TranscriptionHints,
		]
	>
>;

// stop_recording: fallible, returns the finalized blob id. The error is the
// structured `RecorderError` IPC enum, not a bare string: this assertion is the
// contract proof that the recorder boundary stays typed.
type _StopRecording = Expect<
	Equal<
		ReturnType<typeof commands.stopRecording>,
		Promise<Result<string, IpcRecorderError>>
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
		Promise<Result<LocalTranscript, TranscriptionError>>
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
