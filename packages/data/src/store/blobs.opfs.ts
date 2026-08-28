/**
 * `Blobs` over the origin private file system, on the main thread.
 *
 * ## Why there is no worker here
 *
 * The OPFS work this replaces needed one, and the reason was never OPFS: a
 * SQLite VFS needs exclusive synchronous access handles, and those exist only
 * inside a worker. That forced a `MessageChannel` proxy, a worker entry, and a
 * WebAssembly asset to carry a database that this design does not have. With a
 * document stored as one value, the async file API is the whole requirement,
 * and it is available on the main thread.
 *
 * ## Why the atomicity is the platform's rather than ours
 *
 * `createWritable()` does not write through to the file. It writes to a swap
 * file and replaces the target only when the stream closes, so a torn value is
 * unreachable rather than unlikely. That is exactly the write-then-rename this
 * design would otherwise have had to implement, and getting it from the
 * platform means there is no temporary file of ours to leak or to collect.
 *
 * ## What is assumed about the platform, in full
 *
 * The types below are declared rather than imported, the same move `claims.ts`
 * makes for the Web Locks API and for the same reason: this file compiles in a
 * program without the DOM library, and writing down the slice keeps the
 * assumption auditable and lets `test-opfs.ts` implement precisely it. If a
 * method is not named here, this file does not use it.
 */

import type { Blobs } from './blobs.js';
import { keySegments } from './blobs.js';

type FileSystemWritableFileStream = {
	write(data: Uint8Array): Promise<void>;
	close(): Promise<void>;
};

type FileSystemFileHandle = {
	readonly kind: 'file';
	readonly name: string;
	getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
	createWritable(): Promise<FileSystemWritableFileStream>;
};

type FileSystemDirectoryHandle = {
	readonly kind: 'directory';
	readonly name: string;
	getDirectoryHandle(
		name: string,
		options?: { create?: boolean },
	): Promise<FileSystemDirectoryHandle>;
	getFileHandle(
		name: string,
		options?: { create?: boolean },
	): Promise<FileSystemFileHandle>;
	removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
	values(): AsyncIterableIterator<
		FileSystemDirectoryHandle | FileSystemFileHandle
	>;
};

type StorageManagerSlice = {
	getDirectory(): Promise<FileSystemDirectoryHandle>;
};

function storage(): StorageManagerSlice {
	// Through `unknown`, because a runtime that ships its own DOM types declares
	// a `FileSystemDirectoryHandle` of its own and the two are compared
	// structurally. What this file may call is the slice above, and asserting it
	// here is what keeps that true.
	const found = (
		globalThis as unknown as {
			navigator?: { storage?: StorageManagerSlice };
		}
	).navigator?.storage;
	if (found?.getDirectory === undefined) {
		throw new Error('This runtime has no origin private file system');
	}
	return found;
}

/**
 * A missing entry, told apart from a real failure.
 *
 * `NotFoundError` is what the specification names, and matching on the name
 * rather than on the constructor keeps this true across a realm boundary and
 * across a test double that cannot extend the platform's `DOMException`.
 */
function isMissing(cause: unknown): boolean {
	return (cause as { name?: string } | null)?.name === 'NotFoundError';
}

/**
 * This store's bytes, under `root` in the origin private file system.
 *
 * `root` is the store's own address (ADR-0261), so two stores never share a
 * directory and discarding one is removing its directory. Nothing outside that
 * subtree is ever touched, which is what makes a discard's blast radius the
 * address and nothing else.
 */
export function createOpfsBlobs({ root }: { root: string }): Blobs {
	const rootSegments = keySegments(root);

	/** Walk to a directory, optionally creating the path on the way. */
	async function directory(
		segments: readonly string[],
		create: boolean,
	): Promise<FileSystemDirectoryHandle | undefined> {
		let handle = await storage().getDirectory();
		for (const segment of segments) {
			try {
				handle = await handle.getDirectoryHandle(segment, { create });
			} catch (cause) {
				if (!create && isMissing(cause)) return undefined;
				throw cause;
			}
		}
		return handle;
	}

	/** The directory holding a key's file, and the file's own name. */
	function place(key: string): { path: string[]; name: string } {
		const segments = [...rootSegments, ...keySegments(key)];
		const name = segments.pop() as string;
		return { path: segments, name };
	}

	return Object.freeze({
		async read(key) {
			const { path, name } = place(key);
			const parent = await directory(path, false);
			if (parent === undefined) return undefined;
			try {
				const file = await (await parent.getFileHandle(name)).getFile();
				return new Uint8Array(await file.arrayBuffer());
			} catch (cause) {
				if (isMissing(cause)) return undefined;
				throw cause;
			}
		},

		async write(key, bytes) {
			const { path, name } = place(key);
			const parent = await directory(path, true);
			if (parent === undefined) {
				// Unreachable with `create: true`; a directory that could not be made
				// throws rather than answering undefined.
				throw new Error(`Could not open the directory holding ${key}`);
			}
			const handle = await parent.getFileHandle(name, { create: true });
			const stream = await handle.createWritable();
			// The close is what publishes the swap file, so it is not a formality
			// and it is not optional. A throw before it leaves the previous value
			// in place, which is the guarantee this adapter is chosen for.
			await stream.write(bytes);
			await stream.close();
		},

		async remove(key) {
			const { path, name } = place(key);
			const parent = await directory(path, false);
			if (parent === undefined) return;
			try {
				await parent.removeEntry(name, { recursive: true });
			} catch (cause) {
				if (isMissing(cause)) return;
				throw cause;
			}
		},

		async list(prefix) {
			const relative = prefix === '' ? [] : keySegments(prefix);
			const start = await directory([...rootSegments, ...relative], false);
			if (start === undefined) return [];
			const keys: string[] = [];
			await collect(start, relative);
			return keys;

			async function collect(
				handle: FileSystemDirectoryHandle,
				trail: readonly string[],
			): Promise<void> {
				for await (const entry of handle.values()) {
					const here = [...trail, entry.name];
					if (entry.kind === 'file') {
						keys.push(here.join('/'));
					} else {
						await collect(entry, here);
					}
				}
			}
		},
	});
}
