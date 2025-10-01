import type { Brand } from 'wellcrafted/brand';
import type { Result } from 'wellcrafted/result';

/**
 * Callback function for providing real-time status updates during multi-step recording operations.
 * These status messages become user-facing toast notifications that provide encouraging progress
 * feedback during recording workflows. The messages are displayed as loading toasts in the UI,
 * helping users understand what's happening during potentially long-running operations.
 *
 * @example
 * ```typescript
 * // Good: User-friendly with emoji and encouraging tone
 * sendStatus({
 *   title: '🎙️ Starting Recording',
 *   description: 'Setting up your microphone...'
 * });
 *
 * sendStatus({
 *   title: '✅ Recording Saved',
 *   description: 'Your recording is ready for transcription!'
 * });
 *
 * // Bad: Technical language, no emoji, not encouraging
 * sendStatus({
 *   title: 'Initializing MediaStream',
 *   description: 'getUserMedia() call in progress'
 * });
 * ```
 */
export type UpdateStatusMessageFn = (args: {
	title: string;
	description: string;
}) => void;

/**
 * Device acquisition outcome after attempting to connect to a recording device.
 *
 * This type represents the result of device selection during recording startup.
 * All outcomes include the deviceId that was ultimately used for recording.
 * When the outcome is 'fallback', appropriate status messages are automatically
 * sent via UpdateStatusMessageFn to inform users about device switching.
 *
 * @example
 * ```typescript
 * // Success: User's preferred device worked
 * { outcome: 'success', deviceId: 'preferred-device-id' as DeviceIdentifier }
 *
 * // Fallback: No device selected, used default
 * // Status message: "🔍 No Device Selected" -> "Using your default microphone instead"
 * {
 *   outcome: 'fallback',
 *   reason: 'no-device-selected',
 *   deviceId: 'default' as DeviceIdentifier
 * }
 *
 * // Fallback: Preferred device unavailable, used alternative
 * // Status message: "⚠️ Finding a New Microphone" -> "Using MacBook Pro Microphone instead"
 * {
 *   outcome: 'fallback',
 *   reason: 'preferred-device-unavailable',
 *   deviceId: 'MacBook Pro Microphone' as DeviceIdentifier
 * }
 * ```
 */
export type DeviceAcquisitionOutcome =
	| {
			outcome: 'success';
			deviceId: DeviceIdentifier;
	  }
	| {
			outcome: 'fallback';
			reason: 'no-device-selected' | 'preferred-device-unavailable';
			deviceId: DeviceIdentifier;
	  };

/**
 * Common recording service interface that both manual and CPAL recorders implement.
 *
 * Note: While both services follow this general shape, they may have platform-specific
 * parameters and return types. This interface represents the minimal common API.
 *
 * **Status Messaging Integration**: All recording methods that perform multi-step operations
 * (startRecording, stopRecording, cancelRecording) accept an UpdateStatusMessageFn callback
 * to provide real-time progress feedback to users through toast notifications.
 */
export type RecordingService = {
	/**
	 * Enumerate available recording devices
	 * @returns Array of device names/labels as identifiers
	 */
	enumerateRecordingDeviceIds(): Promise<Result<DeviceIdentifier[], unknown>>;

	/**
	 * Start recording with the specified device
	 * @param selectedDeviceId - The device identifier to use (or null for default)
	 * @param recordingId - Unique identifier for this recording session
	 * @returns Information about device acquisition outcome
	 */
	startRecording(params: {
		selectedDeviceId: DeviceIdentifier | null;
		recordingId: string;
		// Platform-specific params can be added here
	}): Promise<Result<DeviceAcquisitionOutcome, unknown>>;

	/**
	 * Stop the current recording
	 * @returns The recorded audio as a Blob
	 */
	stopRecording(): Promise<Result<Blob, unknown>>;

	/**
	 * Cancel the current recording without saving
	 */
	cancelRecording(): Promise<Result<void, unknown>>;
};

/**
 * Platform-agnostic device identifier for audio recording devices.
 *
 * On Web (Navigator API):
 *   - This is the unique `deviceId` from MediaDeviceInfo (e.g., "default" or a GUID)
 *   - NOT the device label. We use the actual deviceId for uniqueness
 *
 * On Desktop (CPAL):
 *   - This is the device name as a string (e.g., "MacBook Pro Microphone")
 *   - The name serves as both identifier and label
 *
 * While these represent different concepts on each platform, they serve the same
 * purpose: uniquely identifying a recording device for selection and persistence.
 * The branded type ensures type safety and makes the dual nature explicit.
 *
 * @example
 * // Web: Stores the deviceId (unique identifier, NOT the label)
 * const deviceIdentifier: DeviceIdentifier = "8a7b9c..." as DeviceIdentifier;
 *
 * // Desktop: Stores the device name (which is both ID and label)
 * const deviceIdentifier: DeviceIdentifier = "MacBook Pro Microphone" as DeviceIdentifier;
 */
export type DeviceIdentifier = string & Brand<'DeviceIdentifier'>;

/**
 * Represents an audio recording device with both a unique identifier and human-readable label.
 *
 * On Web (Navigator API):
 *   - `id`: The unique deviceId from MediaDeviceInfo (e.g., "default" or a GUID)
 *   - `label`: The human-readable device label (e.g., "Built-in Microphone")
 *
 * On Desktop (CPAL):
 *   - `id`: The device name (e.g., "MacBook Pro Microphone")
 *   - `label`: The same device name (identical to id for desktop)
 *
 * This separation allows for better UX (showing readable names) while maintaining
 * stable identifiers for settings persistence.
 *
 * @example
 * // Web device
 * const device: Device = {
 *   id: "8a7b9c..." as DeviceIdentifier,
 *   label: "Blue Yeti USB Microphone"
 * };
 *
 * // Desktop device
 * const device: Device = {
 *   id: "MacBook Pro Microphone" as DeviceIdentifier,
 *   label: "MacBook Pro Microphone"
 * };
 */
export type Device = {
	id: DeviceIdentifier;
	label: string;
};

/**
 * Type guard to convert a string to DeviceIdentifier
 * Use this when receiving device identifiers from external sources
 * @see DeviceIdentifier
 */
export function asDeviceIdentifier(value: string): DeviceIdentifier {
	return value as DeviceIdentifier;
}
