export const PLAYBACK_SUPPRESSION_VALUES = [
	'off',
	'duck',
	'mute',
	'pause',
] as const;

export const PLAYBACK_SUPPRESSION_OPTIONS = [
	{ value: 'off', label: 'Keep playing' },
	{ value: 'duck', label: 'Lower volume' },
	{ value: 'mute', label: 'Mute' },
	{ value: 'pause', label: 'Pause' },
] as const;
