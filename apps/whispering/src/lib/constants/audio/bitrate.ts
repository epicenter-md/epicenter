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

const BITRATE_LABELS: Record<(typeof BITRATES_KBPS)[number], string> = {
	'16': '16 kbps — ultra-small',
	'32': '32 kbps — speech optimized ✓',
	'64': '64 kbps',
	'96': '96 kbps',
	'128': '128 kbps',
	'192': '192 kbps',
	'256': '256 kbps',
	'320': '320 kbps — highest quality',
};

export const BITRATE_OPTIONS = BITRATES_KBPS.map((bitrate) => ({
	label: BITRATE_LABELS[bitrate],
	value: bitrate,
}));

export const DEFAULT_BITRATE_KBPS =
	'32' as const satisfies (typeof BITRATES_KBPS)[number];
