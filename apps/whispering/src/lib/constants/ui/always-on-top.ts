/**
 * Window always-on-top behavior options
 */

export const ALWAYS_ON_TOP_MODES = [
	'Always',
	'When Recording and Transcribing',
	'When Recording',
	'Never',
] as const;

export const ALWAYS_ON_TOP_MODE_OPTIONS = ALWAYS_ON_TOP_MODES.map((mode) => ({
	label: mode,
	value: mode,
}));
