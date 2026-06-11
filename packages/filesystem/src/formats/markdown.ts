import {
	defaultMarkdownParser,
	defaultMarkdownSerializer,
	schema as markdownSchema,
} from 'prosemirror-markdown';
import {
	prosemirrorToYXmlFragment,
	yXmlFragmentToProseMirrorRootNode,
} from 'y-prosemirror';
import type * as Y from 'yjs';

export { markdownSchema };

/** Parse a markdown string into front matter record + body string */
export function parseFrontmatter(content: string): {
	frontmatter: Record<string, unknown>;
	body: string;
} {
	if (!content.startsWith('---\n')) return { frontmatter: {}, body: content };
	const endIndex = content.indexOf('\n---\n', 4);
	if (endIndex === -1) {
		// Check for front matter at end of file (no trailing content)
		if (content.endsWith('\n---')) {
			const yaml = content.slice(4, content.length - 4);
			return { frontmatter: parseYamlSimple(yaml), body: '' };
		}
		return { frontmatter: {}, body: content };
	}
	const yaml = content.slice(4, endIndex);
	const body = content.slice(endIndex + 5);
	return { frontmatter: parseYamlSimple(yaml), body };
}

/** Combine front matter and body into a markdown string with --- delimiters */
export function serializeMarkdownWithFrontmatter(
	frontmatter: Record<string, unknown>,
	body: string,
): string {
	const keys = Object.keys(frontmatter);
	if (keys.length === 0) return body;
	const yaml = keys
		.map((key) => `${key}: ${stringifyYamlValue(frontmatter[key])}`)
		.join('\n');
	return `---\n${yaml}\n---\n${body}`;
}

/** Diff-update a Y.Map to match a target record. Per-field LWW. */
export function updateYMapFromRecord(
	ymap: Y.Map<unknown>,
	target: Record<string, unknown>,
): void {
	const doc = ymap.doc;
	const apply = () => {
		// Delete keys not in target
		const keysToDelete: string[] = [];
		ymap.forEach((_, key) => {
			if (!(key in target)) keysToDelete.push(key);
		});
		for (const key of keysToDelete) ymap.delete(key);

		// Set/update keys from target
		for (const [key, value] of Object.entries(target)) {
			const current = ymap.get(key);
			if (!deepEqual(current, value)) ymap.set(key, value);
		}
	};

	if (doc) {
		doc.transact(apply);
	} else {
		apply();
	}
}

/** Convert Y.Map to a plain Record */
export function yMapToRecord(ymap: Y.Map<unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	ymap.forEach((value, key) => {
		result[key] = value;
	});
	return result;
}

/**
 * Serialize a Y.XmlFragment to a markdown string.
 * Headless pipeline: no DOM needed.
 */
export function serializeXmlFragmentToMarkdown(
	fragment: Y.XmlFragment,
): string {
	const node = yXmlFragmentToProseMirrorRootNode(fragment, markdownSchema);
	return defaultMarkdownSerializer.serialize(node);
}

/**
 * Update a Y.XmlFragment from a markdown string.
 * Uses prosemirrorToYXmlFragment which diffs against existing content.
 */
export function updateYXmlFragmentFromString(
	fragment: Y.XmlFragment,
	markdown: string,
): void {
	const doc = defaultMarkdownParser.parse(markdown);
	if (!doc) return;
	prosemirrorToYXmlFragment(doc, fragment);
}

// ═══════════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ═══════════════════════════════════════════════════════════════════════

/** Simple YAML parser for front matter (handles key: value pairs) */
function parseYamlSimple(yaml: string): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const line of yaml.split('\n')) {
		const colonIndex = line.indexOf(':');
		if (colonIndex === -1) continue;
		const key = line.slice(0, colonIndex).trim();
		const rawValue = line.slice(colonIndex + 1).trim();
		if (!key) continue;
		result[key] = parseYamlValue(rawValue);
	}
	return result;
}

/** Parse a simple YAML value (string, number, boolean, array) */
function parseYamlValue(raw: string): unknown {
	if (raw === 'true') return true;
	if (raw === 'false') return false;
	if (raw === 'null' || raw === '') return null;
	if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);

	// Simple array: [item1, item2]
	if (raw.startsWith('[') && raw.endsWith(']')) {
		return raw
			.slice(1, -1)
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean)
			.map(parseYamlValue);
	}

	// Quoted string
	if (
		(raw.startsWith('"') && raw.endsWith('"')) ||
		(raw.startsWith("'") && raw.endsWith("'"))
	) {
		return raw.slice(1, -1);
	}

	return raw;
}

/** Stringify a YAML value for output */
function stringifyYamlValue(value: unknown): string {
	if (value === null || value === undefined) return 'null';
	if (typeof value === 'boolean') return String(value);
	if (typeof value === 'number') return String(value);
	if (Array.isArray(value))
		return `[${value.map(stringifyYamlValue).join(', ')}]`;
	if (typeof value === 'string') {
		// Quote strings that contain special characters
		if (
			value.includes(':') ||
			value.includes('#') ||
			value.includes('\n') ||
			value === ''
		) {
			return `"${value.replace(/"/g, '\\"')}"`;
		}
		return value;
	}
	return JSON.stringify(value);
}

/** Deep equality check for JSON-compatible values */
function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null) return false;
	if (typeof a !== typeof b) return false;
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false;
		return a.every((v, i) => deepEqual(v, b[i]));
	}
	if (isRecord(a) && isRecord(b)) {
		const keysA = Object.keys(a);
		const keysB = Object.keys(b);
		if (keysA.length !== keysB.length) return false;
		return keysA.every((k) => deepEqual(a[k], b[k]));
	}
	return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
