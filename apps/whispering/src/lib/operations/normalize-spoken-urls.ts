const WORD = String.raw`[\p{L}\p{N}]+`;
const DOMAIN_LABEL = String.raw`${WORD}(?:\s+(?:dash|hyphen)\s+${WORD})*`;
const DOMAIN = String.raw`${DOMAIN_LABEL}(?:\s+(?:dot|period)\s+${DOMAIN_LABEL})+`;
const PATH_SEGMENT = String.raw`${WORD}(?:\s+(?:dash|hyphen|underscore)\s+${WORD})*`;
const PATH = String.raw`(?:\s+(?:forward\s+)?slash\s+${PATH_SEGMENT})*`;

const SPOKEN_URL = new RegExp(
	String.raw`\b(https?)\s+colon\s+(?:forward\s+)?slash\s+(?:forward\s+)?slash\s+(${DOMAIN})(?:\s+colon\s+(\d{1,5}))?(${PATH})`,
	'giu',
);

function normalizeDomain(domain: string): string {
	return domain
		.replace(/\s+(?:dash|hyphen)\s+/giu, '-')
		.replace(/\s+(?:dot|period)\s+/giu, '.')
		.toLowerCase();
}

function normalizePath(path: string): string {
	return path
		.replace(/\s+(?:forward\s+)?slash\s+/giu, '/')
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
			`${protocol.toLowerCase()}://${normalizeDomain(domain)}${port ? `:${port}` : ''}${normalizePath(path)}`,
	);
}
