import { RecorderError } from '$lib/services/recorder/contract';
import type { IpcRecorderError } from '$lib/tauri/commands.types';

/**
 * Map a structured Rust recorder error (the `{ name, message }` IPC enum) to a
 * cross-cutting service `RecorderError`, or `null` to let the call site apply
 * its own verb (InitFailed at init, StartFailed at start, StopFailed at stop).
 *
 * Only the cross-cutting cases override, the ones whose meaning is the same
 * whichever command surfaced them: a microphone permission denial, a missing
 * input device, a recorder already in use, and a recording that has already
 * ended. Everything else returns `null` so the call site keeps its contextual
 * variant.
 *
 * The permission/no-device classification is owned by Rust
 * (`RecorderError::classify_cpal`), where cpal's typed errors and the OS access
 * signals are still in hand. The frontend switches on `error.name`; it never
 * matches message text or localized OS strings.
 */
export function recorderErrorFromIpc(error: IpcRecorderError) {
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
			// Generic recording failure: let the call site label it by verb
			// (InitFailed at init, StartFailed at start, StopFailed at stop).
			return null;
	}
}
