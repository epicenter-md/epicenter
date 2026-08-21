const WORD = String.raw`[\p{L}\p{N}]+`;
const DOMAIN_LABEL = String.raw`${WORD}(?:\s+(?:dash|hyphen)\s+${WORD})*`;
const DOMAIN_SEPARATOR = String.raw`(?:\s+(?:dot|period)\s+|\s*\.\s*)`;
const DOMAIN = `${DOMAIN_LABEL}(?:${DOMAIN_SEPARATOR}${DOMAIN_LABEL})+`;
const PATH_SEGMENT = String.raw`${WORD}(?:\s+(?:dash|hyphen|underscore)\s+${WORD})*`;
const SPOKEN_SLASH = String.raw`(?:forward\s+)?slash`;
const FOLLOWING_PROSE = '(?:and|or|but|then|please|right)';
const PATH = String.raw`(?:\s+${SPOKEN_SLASH}\s+(?!${FOLLOWING_PROSE}\b)${PATH_SEGMENT})*(?:\s+${SPOKEN_SLASH}(?=\s+(?:${FOLLOWING_PROSE})\b|[.!?]|$))?`;
const SCHEME_SEPARATOR = String.raw`\s*(?:(?:colon|:)\s*)?(?:,\s*)?${SPOKEN_SLASH}(?:\s+${SPOKEN_SLASH})?(?:,\s*|\s+)`;

const SPOKEN_URL = new RegExp(
	String.raw`\b(https|http\s+s|http)${SCHEME_SEPARATOR}(${DOMAIN})(?:\s+colon\s+(\d{1,5}))?(${PATH})`,
	'giu',
);

function normalizeDomain(domain: string): string {
	return domain
		.replace(/\s+(?:dash|hyphen)\s+/giu, '-')
		.replace(/\s+(?:dot|period)\s+/giu, '.')
		.replace(/\s*\.\s*/gu, '.')
		.toLowerCase();
}

function normalizePath(path: string): string {
	return path
		.replace(/\s+(?:forward\s+)?slash(?:\s+|$)/giu, '/')
		.replace(/\s+(?:dash|hyphen)\s+/giu, '-')
		.replace(/\s+underscore\s+/giu, '_');
}

/**
 * Convert explicit spoken URL punctuation into URL syntax without an AI call.
 *
 * Recognition starts only at a spoken HTTP(S) scheme and requires a dotted
 * domain. That narrow boundary keeps ordinary prose such as “connect the dots”
 * or “run the slash command” untouched. Domain names are lower-cased because
 * DNS is case-insensitive; path casing is preserved because paths may not be.
 */
export function normalizeSpokenUrls(text: string): string {
	return text.replace(
		SPOKEN_URL,
		(
			_match,
			protocol: string,
			domain: string,
			port: string | undefined,
			path: string,
		) =>
			`${protocol.replaceAll(/\s/gu, '').toLowerCase()}://${normalizeDomain(domain)}${port ? `:${port}` : ''}${normalizePath(path)}`,
	);
}
