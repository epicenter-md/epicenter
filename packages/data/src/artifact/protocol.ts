/**
 * What a mirror pass looks like on the wire (ADR-0271).
 *
 * Pure, and that is the whole reason it is its own module. The host reads this
 * to parse a pass and the WebView reads it to compose one, so it must reach
 * the host without bringing a store, a definition, or a CRDT with it. The
 * row-file format made the same move for the same reason (`format.ts`); this
 * is its wire-level twin.
 *
 * ## The pass
 *
 * NDJSON, one object per line, so neither side ever holds a whole store at
 * once:
 *
 * ```txt
 * {"path":"notes/abc.md","contents":"---\ntitle: …\n---\n\n# …"}
 * {"path":"kv.json","contents":"{…}"}
 * {"manifest":["kv.json","notes/abc.md"]}
 * ```
 *
 * A pass STATES what the store holds. It never says what to do to the
 * folder file by file and never asks what the folder currently contains: the
 * host owns the folder, so the host owns the diff.
 *
 * The manifest is last and arrives exactly once. Everything the folder holds
 * that a render is responsible for and the manifest does not name is a row
 * that no longer exists. Until the manifest arrives nothing is removed, so a
 * connection dropped mid-pass leaves the folder stale rather than gutted.
 *
 * A path present in the manifest with no contents line means "leave that file
 * alone", which is how a row whose render failed keeps the file it already
 * has.
 *
 * ## One inverse pair, one home
 *
 * `mirrorLine` and its inverse live together for the reason `rowPath` and
 * `parseRowPath` do: composed at one end and parsed at the other, in two
 * files, is how a wire format drifts, because one of them gets a fix and the
 * other does not. Only the loop is public, because a caller wants a pass and
 * never one line.
 */

/** The host path shared by its server and every WebView that renders. */
export const MIRROR_PATH = '/api/mirror';

/** One line of a pass: a file to write, or the manifest that ends it. */
export type MirrorLine =
	| { readonly path: string; readonly contents: string }
	| { readonly manifest: readonly string[] };

/** One line, encoded with its terminator, ready to concatenate. */
export function mirrorLine(line: MirrorLine): string {
	return `${JSON.stringify(line)}\n`;
}

/**
 * One line, read back, or `undefined` when it is not one.
 *
 * `undefined` is a fact rather than a failure. A line the host cannot read is
 * one file's worth of a pass, not the pass: skipping it leaves that file as it
 * was, and the manifest then protects it from the sweep.
 */
function parseMirrorLine(line: string): MirrorLine | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof value !== 'object' || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (Array.isArray(record.manifest)) {
		if (!record.manifest.every((entry) => typeof entry === 'string')) {
			return undefined;
		}
		return { manifest: record.manifest as string[] };
	}
	if (typeof record.path === 'string' && typeof record.contents === 'string') {
		return { path: record.path, contents: record.contents };
	}
	return undefined;
}

/** Every line of one batch, skipping blanks and anything unreadable. */
export function* parseMirrorPass(ndjson: string): Generator<MirrorLine> {
	for (const line of ndjson.split('\n')) {
		if (line.trim() === '') continue;
		const parsed = parseMirrorLine(line);
		if (parsed !== undefined) yield parsed;
	}
}
