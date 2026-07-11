import { RecorderError } from '$lib/services/recorder/contract';
import type { IpcRecorderError } from '$lib/tauri/commands.types';

/**
 * Map a structured Rust recorder error (the `{ name, message }` IPC enum) to a
 * cross-cutting service `RecorderError`, or `null` to let the call site apply
 * its own verb (InitFailed at init, StartFailed at start, StopFailed at stop).
 *
 * Only the two cross-cutting cases override: a microphone permission denial and
 * a missing input device, which any recorder command can surface and which the
 * UI presents the same way regardless of which command hit them. Everything
 * else returns `null` so the call site keeps its contextual variant.
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
		case 'Failed':
			// Generic recording failure: let the call site label it by verb
			// (InitFailed at init, StartFailed at start, StopFailed at stop).
			return null;
	}
}
