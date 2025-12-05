/**
 * Icon mappings for various states
 * These are exported from the audio module since they're tightly coupled
 * with recording states, but could be used by UI components
 */

// Re-export from audio since these are tied to recording states
export {
	RECORDER_STATE_TO_ICON,
	VAD_STATE_TO_ICON,
} from '../audio/recording-states';
