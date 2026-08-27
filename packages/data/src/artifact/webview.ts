/**
 * The WebView half of the mirror: where a rendered file is sent (ADR-0271).
 *
 * The application renders and the host writes bytes, so something has to carry
 * one to the other. That is a same-origin request on the trusted Epicenter
 * origin, which needs no capability grant, and this is the one place its shape
 * is written down: the host declares its route from `MIRROR_PATH` and an
 * application builds its URL from the same constant, so the two cannot drift.
 *
 * Deliberately thin. It sends a path and bytes and reports whether that
 * worked. It does not batch, retry, queue, or remember: the mirror is derived
 * from a store that already persisted the commit, so a file that failed to
 * write is re-rendered by the next commit or the next boot, and a retry queue
 * here would be a second durability story competing with the real one.
 */
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import { defineErrors, type InferErrors } from 'wellcrafted/error';

/** The host path shared by its server and every WebView that renders. */
export const MIRROR_PATH = '/api/mirror';

/** Where a workspace's files live, and the only two answers (ADR-0271). */
export type MirrorWorkspace = 'account' | 'on-this-device';

export const MirrorSinkError = defineErrors({
	/**
	 * The host refused or could not write. The folder is a convenience over a
	 * filesystem that may be full, read-only, or on a drive someone unplugged;
	 * the store is unaffected, so this is reported and never thrown.
	 */
	MirrorWriteFailed: ({
		path,
		status,
		cause,
	}: { path: string; status?: number; cause?: unknown }) => ({
		message: `The mirror could not write '${path}'`,
		path,
		status,
		cause,
	}),
});
export type MirrorSinkError = InferErrors<typeof MirrorSinkError>;

/** The absolute same-origin URL one rendered file is sent to. */
export function mirrorFileUrl({
	workspace,
	definitionId,
	path,
}: {
	workspace: MirrorWorkspace;
	definitionId: string;
	path: string;
}): string {
	// The path's segments come from the address grammar and are already safe,
	// but they are encoded anyway: this builds a URL, and a URL builder that
	// trusts its inputs is the one that stops being true when an input changes.
	const segments = path.split('/').map(encodeURIComponent).join('/');
	return `${MIRROR_PATH}/${encodeURIComponent(workspace)}/${encodeURIComponent(definitionId)}/${segments}`;
}

export type MirrorSink = {
	/** Put one rendered file at its path. */
	write(path: string, contents: string): Promise<Result<void, MirrorSinkError>>;
	/** Take one file away, for a row that no longer exists. */
	remove(path: string): Promise<Result<void, MirrorSinkError>>;
	/**
	 * Every path the folder currently holds.
	 *
	 * Names, never contents, and the distinction is the seam to guard: knowing
	 * which files exist is how a render deletes what a row no longer justifies,
	 * while reading one back is where ADR-0207's whole write direction starts
	 * growing again. Nothing in this package reads a rendered file.
	 */
	list(): Promise<Result<string[], MirrorSinkError>>;
};

/**
 * The sink one workspace's files go to.
 *
 * `fetch` is injected so a test drives this without a host and without a
 * network, which is the whole of what makes the caller testable.
 */
export function createMirrorSink({
	workspace,
	definitionId,
	fetch: httpFetch = globalThis.fetch,
}: {
	workspace: MirrorWorkspace;
	definitionId: string;
	fetch?: typeof globalThis.fetch;
}): MirrorSink {
	async function send(
		path: string,
		init: RequestInit,
	): Promise<Result<void, MirrorSinkError>> {
		const url = mirrorFileUrl({ workspace, definitionId, path });
		const { data: response, error } = await tryAsync({
			try: () => httpFetch(url, init),
			catch: (cause) => MirrorSinkError.MirrorWriteFailed({ path, cause }),
		});
		if (error !== null) return Err(error);
		if (!response.ok) {
			return MirrorSinkError.MirrorWriteFailed({
				path,
				status: response.status,
			});
		}
		return Ok(undefined);
	}

	return {
		write: (path, contents) =>
			send(path, {
				method: 'PUT',
				body: contents,
				headers: { 'content-type': 'text/plain; charset=utf-8' },
			}),
		remove: (path) => send(path, { method: 'DELETE' }),
		async list(): Promise<Result<string[], MirrorSinkError>> {
			const url = mirrorFolderUrl({ workspace, definitionId });
			const { data: response, error } = await tryAsync({
				try: () => httpFetch(url),
				catch: (cause) =>
					MirrorSinkError.MirrorWriteFailed({ path: '', cause }),
			});
			if (error !== null) return Err(error);
			if (!response.ok) {
				return MirrorSinkError.MirrorWriteFailed({
					path: '',
					status: response.status,
				});
			}
			const { data: paths, error: bodyError } = await tryAsync({
				try: () => response.json() as Promise<string[]>,
				catch: (cause) =>
					MirrorSinkError.MirrorWriteFailed({ path: '', cause }),
			});
			if (bodyError !== null) return Err(bodyError);
			return Ok(paths);
		},
	};
}

/** The absolute same-origin URL one workspace's folder is listed at. */
export function mirrorFolderUrl({
	workspace,
	definitionId,
}: {
	workspace: MirrorWorkspace;
	definitionId: string;
}): string {
	return `${MIRROR_PATH}/${encodeURIComponent(workspace)}/${encodeURIComponent(definitionId)}`;
}

export { attachMirror, type MirrorableData } from './mirror.js';
