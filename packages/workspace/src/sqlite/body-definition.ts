/**
 * Row-body declarations (ADR-0130/0133). A table may declare at most one
 * text or rich-text body per row. The declaration is inert: the body's merge
 * engine, update log, and transport are runtime concerns, and its identity is
 * never a public string or parameter record.
 */

export type BodyFormat = 'text' | 'richText';

export type BodyDefinition<TFormat extends BodyFormat = BodyFormat> = {
	readonly format: TFormat;
};

const TEXT: BodyDefinition<'text'> = Object.freeze({ format: 'text' });
const RICH_TEXT: BodyDefinition<'richText'> = Object.freeze({
	format: 'richText',
});

export const body = Object.freeze({
	/** One plain-text body per row (a single Y.Text; ADR-0107). */
	text: (): BodyDefinition<'text'> => TEXT,
	/** One rich-text body per row (a single fragment layout; ADR-0106). */
	richText: (): BodyDefinition<'richText'> => RICH_TEXT,
});

export function isBodyDefinition(value: unknown): value is BodyDefinition {
	return (
		typeof value === 'object' &&
		value !== null &&
		'format' in value &&
		((value as BodyDefinition).format === 'text' ||
			(value as BodyDefinition).format === 'richText')
	);
}
