import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { TranscriptionServiceId } from '$lib/services/transcription/providers';

export const AnalyticsError = defineErrors({
	LogEventFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to log analytics event: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type AnalyticsError = InferErrors<typeof AnalyticsError>;

// Settings sections that can be logged
type SettingsSection =
	| 'transcription'
	| 'shortcuts'
	| 'audio'
	| 'appearance'
	| 'analytics'
	| 'recording';

/**
 * Discriminated union of all loggable events.
 * Each event has a 'type' field and optional additional properties.
 * No personal data or user-generated content is ever collected.
 */
export type Event =
	// Application lifecycle
	| { type: 'app_started' }
	// Recording completion events - always include blob_size, duration when available
	| { type: 'manual_recording_completed'; blob_size: number; duration?: number }
	| { type: 'vad_recording_completed'; blob_size: number; duration?: number }
	| { type: 'file_import_completed'; blob_size: number }
	// Transcription events
	| { type: 'transcription_requested'; provider: TranscriptionServiceId }
	| {
			type: 'transcription_completed';
			provider: TranscriptionServiceId;
			duration: number;
	  }
	| {
			type: 'transcription_failed';
			provider: TranscriptionServiceId;
			error_name: string;
			error_message?: string;
	  }
	// Compression events
	| {
			type: 'compression_completed';
			provider: TranscriptionServiceId;
			original_size: number;
			compressed_size: number;
			compression_ratio: number;
	  }
	| {
			type: 'compression_failed';
			provider: TranscriptionServiceId;
			error_message: string;
	  }
	// Settings events
	| { type: 'settings_changed'; section: SettingsSection };

/**
 * Analytics service interface that provides utilities for event logging.
 * Both desktop and web implementations must conform to this interface.
 */
export type AnalyticsService = {
	/**
	 * Send an event to the analytics provider.
	 * Events are typed and validated at compile time.
	 */
	logEvent: (event: Event) => Promise<Result<void, AnalyticsError>>;
};
