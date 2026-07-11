export const BACKGROUND_AUDIO_SUPPRESSION_VALUES = [
	'off',
	'duck',
	'mute',
	'pause',
] as const;

export type BackgroundAudioSuppression =
	(typeof BACKGROUND_AUDIO_SUPPRESSION_VALUES)[number];

export const BACKGROUND_AUDIO_SUPPRESSION_OPTIONS = [
	{ value: 'off', label: 'Off' },
	{ value: 'duck', label: 'Lower volume' },
	{ value: 'mute', label: 'Mute audio' },
	{ value: 'pause', label: 'Pause media (experimental on macOS)' },
] as const;
