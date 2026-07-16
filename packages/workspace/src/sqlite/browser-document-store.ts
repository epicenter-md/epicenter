import type {
	DocumentLocalStore,
	DocumentRoomManifest,
} from './document-runtime.js';

export type IndexedDbDocumentLocalStore = DocumentLocalStore & AsyncDisposable;

/** IndexedDB storage for private room manifests and compact Yjs snapshots. */
export function createIndexedDbDocumentLocalStore(
	name: string,
	indexedDb: IDBFactory,
): IndexedDbDocumentLocalStore {
	let databasePromise: Promise<IDBDatabase> | undefined;
	let isDisposed = false;

	const open = () => {
		if (isDisposed) throw new Error('IndexedDB document store is disposed');
		databasePromise ??= new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDb.open(name, 1);
			request.onupgradeneeded = () => {
				const database = request.result;
				if (!database.objectStoreNames.contains('rooms')) {
					database.createObjectStore('rooms', { keyPath: 'storageRef' });
				}
				if (!database.objectStoreNames.contains('updates')) {
					database.createObjectStore('updates');
				}
			};
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				request.result.onversionchange = () => request.result.close();
				resolve(request.result);
			};
		});
		return databasePromise;
	};

	return {
		async rememberRoom(manifest: DocumentRoomManifest): Promise<void> {
			const database = await open();
			await new Promise<void>((resolve, reject) => {
				const transaction = database.transaction('rooms', 'readwrite');
				const store = transaction.objectStore('rooms');
				const get = store.get(manifest.storageRef);
				get.onsuccess = () => {
					const existing = get.result as DocumentRoomManifest | undefined;
					if (
						existing &&
						JSON.stringify(existing) !== JSON.stringify(manifest)
					) {
						transaction.abort();
						reject(
							new Error(
								'Document storage reference resolved to another manifest',
							),
						);
						return;
					}
					store.put(structuredClone(manifest));
				};
				transaction.oncomplete = () => resolve();
				transaction.onerror = () => reject(transaction.error);
				transaction.onabort = () => {
					if (transaction.error) reject(transaction.error);
				};
			});
		},
		async load(storageRef: string): Promise<Uint8Array | undefined> {
			const database = await open();
			const transaction = database.transaction('updates', 'readonly');
			const value = await idbRequest<ArrayBuffer | Uint8Array | undefined>(
				transaction.objectStore('updates').get(storageRef),
			);
			await idbTransaction(transaction);
			return value === undefined
				? undefined
				: value instanceof Uint8Array
					? value.slice()
					: new Uint8Array(value);
		},
		async save(storageRef: string, update: Uint8Array): Promise<void> {
			const database = await open();
			const transaction = database.transaction('updates', 'readwrite');
			transaction.objectStore('updates').put(update.slice(), storageRef);
			await idbTransaction(transaction);
		},
		async [Symbol.asyncDispose](): Promise<void> {
			if (isDisposed) return;
			isDisposed = true;
			(await databasePromise)?.close();
		},
	};
}

function idbRequest<TResult>(request: IDBRequest<TResult>): Promise<TResult> {
	return new Promise<TResult>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function idbTransaction(transaction: IDBTransaction): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error);
		transaction.onabort = () => reject(transaction.error);
	});
}
