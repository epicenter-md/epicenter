export const QUALITY_OPTIONS = [
	'decent',
	'good',
	'great',
	'excellent',
] as const;

export type Quality = (typeof QUALITY_OPTIONS)[number];
