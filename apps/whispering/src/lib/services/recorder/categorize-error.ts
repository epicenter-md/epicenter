import type { Err } from 'wellcrafted/result';
import { RecorderError } from '$lib/services/recorder/contract';
import type { IpcRecorderError } from '$lib/tauri/commands.types';

/**
 * Map a structured Rust recorder error (the `{ name, message }` IPC enum) onto
 * the service's `RecorderError`.
 *
 * Total, with no null arm. It used to return `null` for the generic case so the
 * call site could label the failure by the verb it had just called
 * (`InitFailed`, `StartFailed`, `StopFailed`), but that told a caller only
 * which function it had itself invoked. With those variants gone every call
 * site mapped the generic case identically, so the choice moved here and the
 * `??` fallback at each call site went away with it.
 *
 * The permission/no-device classification is owned by Rust
 * (`RecorderError::classify_cpal`), where cpal's typed errors and the OS access
 * signals are still in hand. The frontend switches on `error.name`; it never
 * matches message text or localized OS strings.
 */
export function recorderErrorFromIpc(
	error: IpcRecorderError,
): Err<RecorderError> {
	switch (error.name) {
		case 'PermissionDenied':
			return RecorderError.MicrophonePermissionDenied({ cause: error });
		case 'NoInputDevice':
			return RecorderError.NoInputDevice({ cause: error });
		case 'Busy':
			return RecorderError.AlreadyRecording({ cause: error });
		case 'NotRecording':
			return RecorderError.NoActiveRecording({ cause: error });
		case 'Failed':
			return RecorderError.RecorderFailed({ cause: error });
	}
}
