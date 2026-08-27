/**
 * The host's file sink for the `~/Epicenter` mirror (ADR-0271).
 *
 * The host writes bytes at a path it is given and interprets nothing. It does
 * not know what a row is, does not read a file back, and owns no application
 * data: the application holds the rows and the `file` codec and decides what
 * every file contains. That is the same category the host already occupies for
 * blob bytes, which ADR-0226 permitted in its own words, and it is what keeps
 * this from being the second convergent plane that record refused.
 *
 * The route it answers on is `MIRROR_PATH`, declared once in
 * `@epicenter/data/artifact/webview` and read by both ends, so the host and a
 * rendering application cannot drift about where a file is sent.
 *
 * Two things this module owes, and neither is optional.
 *
 * **A path cannot escape the root.** The address grammar already guarantees
 * that a real path is safe (a table name is a bare identifier, a row id is
 * path-safe with no leading dot), so this validates rather than escapes: it
 * accepts exactly the paths the render produces and refuses everything else.
 * Validation reuses `parseRowPath`, the same function that composed the path,
 * so the host and the renderer cannot drift into disagreeing about the layout.
 *
 * **A file is never half-written.** The whole point of the folder is that
 * something else reads it, and an agent that reads a note mid-write sees a
 * truncated one. Every write lands in a temporary file and is renamed into
 * place, which is atomic within a filesystem.
 */

import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { epicenterFolderRoot, isAppId } from '@epicenter/constants/app-data';
import { parseRowPath } from '@epicenter/data/artifact';
import type { MirrorWorkspace } from '@epicenter/data/artifact/webview';

/** Where a workspace's files live, and the only two answers (ADR-0271). */
const MIRROR_WORKSPACES: readonly MirrorWorkspace[] = [
	'account',
	'on-this-device',
];

export function isMirrorWorkspace(value: string): value is MirrorWorkspace {
	return (MIRROR_WORKSPACES as readonly string[]).includes(value);
}

/**
 * The absolute path one mirrored file lives at, or `undefined` when the
 * request does not name one.
 *
 * Every segment is checked against the grammar that produced it rather than
 * sanitized: `..`, an absolute path, a nested directory, and a file that is
 * not a row file or `kv.json` are all simply not paths this produces, so they
 * are refused instead of being cleaned up into something adjacent.
 */
export function mirrorFilePath({
	workspace,
	definitionId,
	path,
	root = epicenterFolderRoot(),
}: {
	workspace: string;
	definitionId: string;
	path: string;
	root?: string;
}): string | undefined {
	if (!isMirrorWorkspace(workspace)) return undefined;
	// The same grammar the data root uses for an app directory: dot-separated,
	// alphanumeric at both ends, so `.` and `..` are refused by construction.
	if (!isAppId(definitionId)) return undefined;
	if (path !== 'kv.json' && parseRowPath(path) === undefined) return undefined;
	return join(root, workspace, definitionId, path);
}

/**
 * Write one file, atomically.
 *
 * The temporary name sits beside the target so the rename stays within one
 * filesystem; a temporary directory elsewhere would make it a copy, and a copy
 * is exactly the half-written file this exists to prevent.
 */
export async function writeMirrorFile(
	absolutePath: string,
	contents: string,
): Promise<void> {
	await mkdir(dirname(absolutePath), { recursive: true });
	const staged = `${absolutePath}.epicenter-tmp`;
	try {
		await writeFile(staged, contents, 'utf8');
		await rename(staged, absolutePath);
	} catch (cause) {
		await rm(staged, { force: true }).catch(() => undefined);
		throw cause;
	}
}

/**
 * Remove one file, if it is there.
 *
 * A row that no longer exists renders no contents, and the caller asks for this
 * instead. Absent is success: the mirror's job is that the file is gone, not
 * that this call is the one that removed it.
 */
export async function removeMirrorFile(absolutePath: string): Promise<void> {
	await rm(absolutePath, { force: true });
}
