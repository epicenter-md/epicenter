const EPICENTER_SCHEME = 'epicenter://';

/**
 * Structured representation of an `epicenter://` URI.
 *
 * Used when markdown needs to point at a specific row in a workspace table
 * workspace table without depending on a file path. The URI format is always
 * `epicenter://{workspace}/{table}/{id}`.
 *
 * @example
 * ```typescript
 * const ref: EpicenterLink = {
 * 	workspace: 'honeycrisp',
 * 	table: 'notes',
 * 	id: '01965a3b-7e2d-7f8a-b3c1-9a4e5f6d7c8b',
 * };
 * ```
 */
export type EpicenterLink = {
	workspace: string;
	table: string;
	id: string;
};

/**
 * Check whether an href uses the `epicenter://` scheme.
 *
 * This is intentionally a cheap prefix check. Some call sites only need a fast
 * discriminator while scanning markdown and do not want full URL parsing yet.
 * Use {@link parseEpicenterLink} when you need validated `workspace`, `table`, and
 * `id` segments.
 *
 * @example
 * ```typescript
 * isEpicenterLink('epicenter://honeycrisp/notes/01965a3b-7e2d-7f8a-b3c1-9a4e5f6d7c8b');
 * // true
 *
 * isEpicenterLink('https://example.com');
 * // false
 * ```
 */
export function isEpicenterLink(href: string): boolean {
	return href.startsWith(EPICENTER_SCHEME);
}

/**
 * Parse an `epicenter://` URI into its workspace, table, and id parts.
 *
 * This is the safe entry point when a caller needs to act on a markdown link.
 * It uses `new URL()` so parsing stays aligned with the platform URL parser,
 * then validates that the URI matches the expected `/{table}/{id}` pathname
 * shape. Invalid or non-Epicenter hrefs return `null` instead of throwing.
 *
 * @example
 * ```typescript
 * parseEpicenterLink('epicenter://honeycrisp/notes/01965a3b-7e2d-7f8a-b3c1-9a4e5f6d7c8b');
 * // {
 * // 	workspace: 'honeycrisp',
 * // 	table: 'notes',
 * // 	id: '01965a3b-7e2d-7f8a-b3c1-9a4e5f6d7c8b',
 * // }
 *
 * parseEpicenterLink('https://example.com/posts/1');
 * // null
 * ```
 */
export function parseEpicenterLink(href: string): EpicenterLink | null {
	if (!isEpicenterLink(href)) return null;

	try {
		const url = new URL(href);
		const [table, id, ...rest] = url.pathname.split('/').filter(Boolean);

		if (!url.hostname || !table || !id || rest.length > 0) return null;

		return {
			workspace: url.hostname,
			table,
			id,
		};
	} catch {
		return null;
	}
}

/**
 * Build an `epicenter://` URI from its workspace, table, and id parts.
 *
 * Use this when generating markdown links that should survive file moves and
 * still point at the same logical record. The returned string is meant to be
 * embedded directly in markdown, for example `[Notes](epicenter://...)`.
 *
 * @example
 * ```typescript
 * const href = makeEpicenterLink(
 * 	'honeycrisp',
 * 	'files',
 * 	'01965a3b-7e2d-7f8a-b3c1-9a4e5f6d7c8b',
 * );
 *
 * // href === 'epicenter://honeycrisp/notes/01965a3b-7e2d-7f8a-b3c1-9a4e5f6d7c8b'
 * ```
 */
export function makeEpicenterLink(
	workspace: string,
	table: string,
	id: string,
): string {
	return `${EPICENTER_SCHEME}${workspace}/${table}/${id}`;
}

/** Regex matching `[display text](epicenter://workspace/table/id)` markdown links. */
export const EPICENTER_LINK_RE = /\[([^\]]+)\]\((epicenter:\/\/[^)]+)\)/g;

/** Regex matching `[[Page Name]]` wikilinks. */
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

/**
 * Convert `epicenter://` markdown links to `[[wikilink]]` syntax.
 *
 * Used by the markdown materializer when exporting workspace content to `.md`
 * files. This keeps the exported files readable in wikilink-aware editors
 * while preserving the original display text from the link.
 * External links such as `https://` URLs are left untouched.
 *
 * @example
 * ```typescript
 * const body =
 * 	'See [Meeting Notes](epicenter://honeycrisp/notes/abc-123) for details.';
 *
 * convertEpicenterLinksToWikilinks(body);
 * // 'See [[Meeting Notes]] for details.'
 * ```
 */
export function convertEpicenterLinksToWikilinks(body: string): string {
	return body.replace(EPICENTER_LINK_RE, '[[$1]]');
}

/**
 * Convert `[[wikilink]]` syntax back to `epicenter://` markdown links.
 *
 * Used when importing `.md` files back into the workspace so wikilinks can be
 * resolved against known file names and restored to the canonical
 * `epicenter://workspace/table/id` form. Unresolved wikilinks are left as-is,
 * which avoids silently inventing references when a name has no unique match.
 *
 * @param body - The markdown body text containing wikilinks.
 * @param resolveName - Lookup function that returns a full `epicenter://`
 * URI for a given page name, or `null` if no unique entity can be resolved.
 *
 * @example
 * ```typescript
 * const body = 'See [[Meeting Notes]] for details.';
 * const resolve = (name: string) =>
 * 	name === 'Meeting Notes'
 * 		? 'epicenter://honeycrisp/notes/abc-123'
 * 		: null;
 *
 * convertWikilinksToEpicenterLinks(body, resolve);
 * // 'See [Meeting Notes](epicenter://honeycrisp/notes/abc-123) for details.'
 * ```
 */
export function convertWikilinksToEpicenterLinks(
	body: string,
	resolveName: (name: string) => string | null,
): string {
	return body.replace(WIKILINK_RE, (match, name: string) => {
		const href = resolveName(name);
		if (href) return `[${name}](${href})`;
		return match;
	});
}
