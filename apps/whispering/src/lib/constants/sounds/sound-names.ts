/**
 * Sound effect names used throughout the application
 */

export const WHISPERING_SOUND_NAMES = [
	'manual-start',
	'manual-stop',
	'manual-cancel',
	'vad-start',
	'vad-capture',
	'vad-stop',
	'transcriptionComplete',
	'transformationComplete',
] as const;

export type WhisperingSoundNames = (typeof WHISPERING_SOUND_NAMES)[number];
