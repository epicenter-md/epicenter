/**
 * The host's half of the `~/Epicenter` mirror (ADR-0271).
 *
 * The application renders and the host owns the folder. A pass arrives saying
 * what the workspace holds; this makes the folder match. The host never opens
 * a store, never decodes a CRDT update, and holds no definition: what it
 * receives is text an application already rendered.
 *
 * It does read files back, in two places, and both are derived-to-derived
 * rather than file-to-row: the sweep reads NAMES to know what is no longer
 * justified. The seam ADR-0271 guards is narrower than "never read" and still
 * holds: nothing derived from a file ever reaches a row.
 *
 * Three things this module owes.
 *
 * **A path cannot escape the folder.** Checked twice, because the two checks
 * promise different things. Containment is the host's own promise about its
 * own root and holds whatever the application sends. The row-file grammar is
 * the application's shape, and refusing anything else is what keeps the folder
 * to what a render produces.
 *
 * **A file is never half-written.** The whole point of the folder is that
 * something else reads it, and an agent that reads a note mid-write sees a
 * truncated one. Every write lands in a temporary file and is renamed into
 * place, which is atomic within a filesystem.
 *
 * **A pass that did not finish deletes nothing.** The manifest arrives last
 * and exactly once. Until it does, files are written and nothing is removed,
 * so a dropped connection leaves the folder stale rather than gutted.
 */

import type { Dirent } from 'node:fs';
import {
	cp,
	mkdtemp,
	mkdir,
	readFile,
	readdir,
	rename,
	rm,
	writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { isAppId } from '@epicenter/constants/app-data';
import { parseRowPath } from '@epicenter/data/artifact/format';
import { parseMirrorPass } from '@epicenter/data/artifact/protocol';

export class MirrorFolderBusyError extends Error {
	override readonly name = 'MirrorFolderBusy';
}

/**
 * The folder a data id's files live in, or `undefined` when the request does
 * not name one. Folder names are one application-owned path segment.
 */
export function mirrorFolderPath({
	folder,
	dataId,
	root,
}: {
	folder: string;
	dataId: string;
	root: string;
}): string | undefined {
	if (!isSafeFolder(folder)) return undefined;
	if (!isAppId(dataId)) return undefined;
	return join(root, dataId, folder);
}

function isSafeFolder(value: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value !== '.' && value !== '..';
}

/**
 * The absolute path one file of a pass lives at, or `undefined`.
 *
 * Containment first, and it is not decoration. `parseRowPath` splits on `/`
 * and checks the extension; it does not enforce the address grammar, so
 * `../x.md` parses as a table named `..`. A grammar check alone would have
 * admitted it. Resolving and comparing against the folder is what actually
 * promises the file lands inside.
 */
function fileInFolder(folder: string, path: string): string | undefined {
	if (path !== 'kv.json' && parseRowPath(path) === undefined) return undefined;
	const target = resolve(folder, path);
	if (target !== folder && !target.startsWith(folder + sep)) return undefined;
	return target;
}

/** Write one file, atomically, staging beside the target so the rename is one. */
async function writeMirrorFile(
	absolutePath: string,
	contents: string,
): Promise<void> {
	// Skip a write whose bytes already match. Not a speed optimization: a
	// rename replaces the inode, so rewriting an unchanged file makes Time
	// Machine, rclone, and Spotlight see the whole vault as new every time a
	// pass runs. A read mutates nothing and costs far less than the churn.
	const existing = await readFile(absolutePath, 'utf8').catch(() => undefined);
	if (existing === contents) return;

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
 * Every path this folder holds that a render is responsible for.
 *
 * Names, never contents. Filtered to what a render produces, because a
 * person's own `README.md` sitting beside their notes is theirs and a sweep
 * has no business removing it (ADR-0271).
 *
 * A folder that is not there yet lists as empty rather than failing: a place
 * that has never rendered has no stale files by definition.
 */
async function listRenderedFiles(absoluteFolder: string): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(absoluteFolder, {
			recursive: true,
			withFileTypes: true,
		});
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.isFile())
		.map((entry) =>
			relative(absoluteFolder, join(entry.parentPath, entry.name)).split(sep),
		)
		.map((segments) => segments.join('/'))
		.filter((path) => path === 'kv.json' || parseRowPath(path) !== undefined);
}

/**
 * Apply one batch of a pass to one folder.
 *
 * Files are written as they arrive. The manifest, when it arrives, ends the
 * pass: everything the folder holds that a render is responsible for and the
 * manifest does not name is a row that no longer exists. A complete pass is
 * staged before the live folder is replaced, so a failed pass never leaves a
 * half-swept folder.
 */
export async function applyMirrorPass(
	absoluteFolder: string,
	ndjson: string,
): Promise<void> {
	const release = await claimMirrorFolder(absoluteFolder);
	try {
		let manifest: readonly string[] | undefined;
		let complete = true;
		const files: { path: string; contents: string }[] = [];
		for (const line of parseMirrorPass(ndjson)) {
			if ('manifest' in line) {
				if (manifest !== undefined) complete = false;
				manifest = line.manifest;
				continue;
			}
			if (manifest !== undefined) complete = false;
			if (fileInFolder(absoluteFolder, line.path) !== undefined) {
				files.push(line);
			}
		}
		if (manifest === undefined || !complete) {
			for (const file of files) {
				const target = fileInFolder(absoluteFolder, file.path);
				if (target !== undefined) await writeMirrorFile(target, file.contents);
			}
			return;
		}

		const named = new Set(manifest);
		const stale = (await listRenderedFiles(absoluteFolder)).filter(
			(path) => !named.has(path),
		);
		if (stale.length === 0) {
			for (const file of files) {
				const target = fileInFolder(absoluteFolder, file.path);
				if (target !== undefined) await writeMirrorFile(target, file.contents);
			}
			return;
		}

		await mkdir(dirname(absoluteFolder), { recursive: true });
		const stagedFolder = await mkdtemp(`${absoluteFolder}.epicenter-stage-`);
		let installed = false;
		try {
			try {
				await cp(absoluteFolder, stagedFolder, {
					recursive: true,
					force: true,
					verbatimSymlinks: true,
				});
			} catch (cause) {
				if (!(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')) {
					throw cause;
				}
			}
			for (const file of files) {
				const target = fileInFolder(stagedFolder, file.path);
				if (target !== undefined) await writeMirrorFile(target, file.contents);
			}
			for (const path of stale) {
				await rm(join(stagedFolder, path), { force: true });
			}

			const previousFolder = `${absoluteFolder}.epicenter-previous-${randomUUID()}`;
			let movedExisting = false;
			try {
				try {
					await rename(absoluteFolder, previousFolder);
					movedExisting = true;
				} catch (cause) {
					if (!(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')) {
						throw cause;
					}
				}
				await rename(stagedFolder, absoluteFolder);
				installed = true;
			} catch (cause) {
				if (movedExisting) await rename(previousFolder, absoluteFolder);
				throw cause;
			} finally {
				if (movedExisting) {
					await rm(previousFolder, { recursive: true, force: true });
				}
			}
		} finally {
			if (!installed) await rm(stagedFolder, { recursive: true, force: true });
		}
	} finally {
		await release();
	}
}

async function claimMirrorFolder(absoluteFolder: string): Promise<() => Promise<void>> {
	const lock = `${absoluteFolder}.epicenter-lock`;
	await mkdir(dirname(lock), { recursive: true });
	try {
		await mkdir(lock);
	} catch (cause) {
		if (cause instanceof Error && 'code' in cause && cause.code === 'EEXIST') {
			throw new MirrorFolderBusyError(`Mirror folder is already claimed: ${absoluteFolder}`);
		}
		throw cause;
	}
	return async () => {
		await rm(lock, { recursive: true, force: true });
	};
}
