/**
 * Audio sample rate constants and options
 */

export const SAMPLE_RATES = ['16000', '44100', '48000'] as const;

export type SampleRate = (typeof SAMPLE_RATES)[number];

/**
 * Sample rate metadata for generating options with descriptions
 */
const SAMPLE_RATE_METADATA: Record<
	SampleRate,
	{ shortLabel: string; description: string }
> = {
	'16000': { shortLabel: '16 kHz', description: 'Optimized for speech' },
	'44100': { shortLabel: '44.1 kHz', description: 'CD quality' },
	'48000': { shortLabel: '48 kHz', description: 'Studio quality' },
};

/**
 * Sample rate options with descriptive labels
 * Format: "16 kHz - Optimized for speech"
 */
export const SAMPLE_RATE_OPTIONS = SAMPLE_RATES.map((rate) => ({
	value: rate,
	label: `${SAMPLE_RATE_METADATA[rate].shortLabel} - ${SAMPLE_RATE_METADATA[rate].description}`,
}));

export const DEFAULT_SAMPLE_RATE =
	'16000' as const satisfies (typeof SAMPLE_RATES)[number];
