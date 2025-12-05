/**
 * Audio bitrate constants and options
 */

export const BITRATES_KBPS = [
	'16',
	'32',
	'64',
	'96',
	'128',
	'192',
	'256',
	'320',
] as const;

export const BITRATE_OPTIONS = BITRATES_KBPS.map((bitrate) => ({
	label: `${bitrate} kbps`,
	value: bitrate,
}));

export const DEFAULT_BITRATE_KBPS =
	'128' as const satisfies (typeof BITRATES_KBPS)[number];
