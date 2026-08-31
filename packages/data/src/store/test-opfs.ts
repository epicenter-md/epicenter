/**
 * An in-process origin private file system, for runtimes that do not ship one.
 *
 * The same move `test-locks.ts` makes, for the same reason: the store's only
 * durable implementation is `blobs.opfs.ts`, and a test runtime without the
 * API would leave it untested rather than test a second implementation written
 * to be testable. Supplying the platform tests the real adapter; adding a
 * memory `Blobs` beside it would recreate the two-implementations problem the
 * `Blobs` seam exists to delete.
 *
 * Deliberately small, and shaped to the slice `blobs.opfs.ts` declares. It
 * implements exactly the methods that file names, so a call this fake does not
 * answer is a call the adapter is not allowed to make.
 *
 * One behaviour is copied from the real thing rather than simplified, because
 * the adapter depends on it: `createWritable` buffers, and the value is
 * published on `close`. A test that drops a stream without closing must see
 * the previous bytes, which is the guarantee the adapter is chosen for.
 */

type Missing = Error & { name: 'NotFoundError' };

function missing(name: string): Missing {
	const error = new Error(`No entry named ${name}`) as Missing;
	error.name = 'NotFoundError';
	return error;
}

type FakeFile = { kind: 'file'; name: string; bytes: Uint8Array };
type FakeDirectory = {
	kind: 'directory';
	name: string;
	children: Map<string, FakeFile | FakeDirectory>;
};

function directoryHandle(node: FakeDirectory): unknown {
	return {
		kind: 'directory',
		name: node.name,
		async getDirectoryHandle(name: string, options?: { create?: boolean }) {
			const found = node.children.get(name);
			if (found?.kind === 'directory') return directoryHandle(found);
			if (found !== undefined) throw missing(name);
			if (options?.create !== true) throw missing(name);
			const made: FakeDirectory = {
				kind: 'directory',
				name,
				children: new Map(),
			};
			node.children.set(name, made);
			return directoryHandle(made);
		},
		async getFileHandle(name: string, options?: { create?: boolean }) {
			const found = node.children.get(name);
			if (found?.kind === 'file') return fileHandle(found);
			if (found !== undefined) throw missing(name);
			if (options?.create !== true) throw missing(name);
			const made: FakeFile = { kind: 'file', name, bytes: new Uint8Array() };
			node.children.set(name, made);
			return fileHandle(made);
		},
		async removeEntry(name: string) {
			if (!node.children.delete(name)) throw missing(name);
		},
		values() {
			const entries = [...node.children.values()];
			return (async function* () {
				for (const entry of entries) {
					yield entry.kind === 'file'
						? fileHandle(entry)
						: directoryHandle(entry);
				}
			})();
		},
	};
}

function fileHandle(node: FakeFile): unknown {
	return {
		kind: 'file',
		name: node.name,
		async getFile() {
			return {
				async arrayBuffer() {
					// A copy, because the real one hands back bytes the caller cannot
					// use to mutate the stored file.
					return node.bytes.slice().buffer;
				},
			};
		},
		async createWritable() {
			const chunks: Uint8Array[] = [];
			return {
				async write(data: Uint8Array) {
					chunks.push(new Uint8Array(data));
				},
				async close() {
					let total = 0;
					for (const chunk of chunks) total += chunk.length;
					const bytes = new Uint8Array(total);
					let at = 0;
					for (const chunk of chunks) {
						bytes.set(chunk, at);
						at += chunk.length;
					}
					// Publication is here and nowhere else: until this line the file
					// still holds what it held before the stream opened.
					node.bytes = bytes;
				},
			};
		},
	};
}

/**
 * Install `navigator.storage.getDirectory` when the runtime has none, and
 * report whether it was installed.
 *
 * Idempotent, and it never replaces a real implementation: a browser running
 * these tests should exercise its own.
 */
export function installTestOpfs(): boolean {
	const scope = globalThis as {
		navigator?: { storage?: { getDirectory?: () => Promise<unknown> } };
	};
	if (scope.navigator?.storage?.getDirectory !== undefined) return false;

	const root: FakeDirectory = {
		kind: 'directory',
		name: '',
		children: new Map(),
	};
	const storage = { getDirectory: async () => directoryHandle(root) };
	if (scope.navigator === undefined) {
		Object.defineProperty(globalThis, 'navigator', {
			configurable: true,
			value: { storage },
		});
		return true;
	}
	Object.defineProperty(scope.navigator, 'storage', {
		configurable: true,
		value: storage,
	});
	return true;
}
