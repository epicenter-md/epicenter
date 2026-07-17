import { canonicalJson } from '@epicenter/row-sync';
import { Value } from 'typebox/value';
import * as Y from 'yjs';
import { assertSafeSegment } from '../shared/safe-segment.js';
import { sha256Hex } from '../shared/sha256.js';
import {
	type DocumentContentFor,
	type DocumentDefinition,
	type DocumentDefinitions,
	type DocumentParamsFor,
	inspectDocumentDefinition,
	isDocumentDefinition,
} from './document-definition.js';

type DocumentOpenArgs<TDefinition extends DocumentDefinition> =
	keyof DocumentParamsFor<TDefinition> extends never
		? []
		: [params: DocumentParamsFor<TDefinition>];

export type OpenedDocument<TContent extends object> = {
	content: TContent;
	[Symbol.dispose](): void;
};

export type DocumentNamespace<TDefinitions extends DocumentDefinitions> = {
	[TName in keyof TDefinitions]: {
		open(
			...args: DocumentOpenArgs<TDefinitions[TName]>
		): Promise<OpenedDocument<DocumentContentFor<TDefinitions[TName]>>>;
	};
};

/** Private, durable catalog entry used for export and room reconstruction. */
export type DocumentRoomManifest = {
	formatVersion: 1;
	storageRef: string;
	workspaceId: string;
	declaration: string;
	documentFormat: string;
	params: Record<string, unknown>;
};

/** Environment-owned persistence for private document rooms and their catalog. */
export type DocumentLocalStore = {
	rememberRoom(manifest: DocumentRoomManifest): Promise<void>;
	load(storageRef: string): Promise<Uint8Array | undefined>;
	save(storageRef: string, update: Uint8Array): Promise<void>;
};

/** Environment-owned remote attachment. It starts after local hydration. */
export type AttachDocumentSync = (
	ydoc: Y.Doc,
	storageRef: string,
) => Disposable;

export type ResolveDocumentRoomManifest = (request: {
	workspaceId: string;
	declaration: string;
	documentFormat: string;
	params: Record<string, unknown>;
}) => Promise<DocumentRoomManifest>;

type LiveRoom = {
	ydoc: Y.Doc;
	refs: number;
	sync: Disposable;
	manifest: string;
};

type OpeningRoom = {
	manifest: string;
	promise: Promise<LiveRoom>;
};

/**
 * Create the private room catalog shared by every workspace in one runtime.
 *
 * The catalog awaits local replay before returning a room, then starts remote
 * synchronization without exposing connection state or manual sync controls.
 */
export function createDocumentRoomCatalog({
	localStore,
	attachSync = () => ({ [Symbol.dispose]() {} }),
}: {
	localStore: DocumentLocalStore;
	attachSync?: AttachDocumentSync;
}) {
	const liveRooms = new Map<string, LiveRoom>();
	const openingRooms = new Map<string, OpeningRoom>();
	const pendingSaves = new Map<string, Promise<void>>();
	const backgroundFailures: unknown[] = [];
	let disposed = false;

	const assertOpen = () => {
		if (disposed) throw new Error('Document room catalog is disposed');
	};

	const unloadIfClean = (storageRef: string): void => {
		if (disposed || pendingSaves.has(storageRef)) return;
		const room = liveRooms.get(storageRef);
		if (!room || room.refs !== 0) return;
		liveRooms.delete(storageRef);
		try {
			room.sync[Symbol.dispose]();
		} finally {
			room.ydoc.destroy();
		}
	};

	const persist = (storageRef: string, ydoc: Y.Doc): void => {
		const update = Y.encodeStateAsUpdate(ydoc);
		const previous = pendingSaves.get(storageRef) ?? Promise.resolve();
		const pending = previous
			.catch(() => undefined)
			.then(() => localStore.save(storageRef, update));
		pendingSaves.set(storageRef, pending);
		void pending.then(
			() => {
				if (pendingSaves.get(storageRef) !== pending) return;
				pendingSaves.delete(storageRef);
				try {
					unloadIfClean(storageRef);
				} catch (cause) {
					backgroundFailures.push(cause);
				}
			},
			() => undefined,
		);
	};

	const createRoom = async (
		manifest: DocumentRoomManifest,
	): Promise<LiveRoom> => {
		const { storageRef } = manifest;
		await localStore.rememberRoom(manifest);
		assertOpen();
		const ydoc = new Y.Doc({ guid: storageRef, gc: true });
		try {
			const stored = await localStore.load(storageRef);
			assertOpen();
			if (stored) Y.applyUpdate(ydoc, stored);
			ydoc.on('update', () => persist(storageRef, ydoc));
			const room = {
				ydoc,
				refs: 0,
				sync: attachSync(ydoc, storageRef),
				manifest: canonicalJson(manifest),
			};
			liveRooms.set(storageRef, room);
			return room;
		} catch (cause) {
			ydoc.destroy();
			throw cause;
		}
	};

	const open = async (manifest: DocumentRoomManifest) => {
		assertOpen();
		const { storageRef } = manifest;
		const encodedManifest = canonicalJson(manifest);
		let room = liveRooms.get(storageRef);
		if (room && room.manifest !== encodedManifest) {
			throw new Error(
				'Document storage reference resolved to another manifest',
			);
		}
		if (!room) {
			let opening = openingRooms.get(storageRef);
			if (!opening) {
				const promise = createRoom(manifest).finally(() =>
					openingRooms.delete(storageRef),
				);
				opening = { manifest: encodedManifest, promise };
				openingRooms.set(storageRef, opening);
			} else if (opening.manifest !== encodedManifest) {
				throw new Error(
					'Document storage reference resolved to another manifest',
				);
			}
			room = await opening.promise;
		}
		assertOpen();
		room.refs += 1;
		let released = false;
		return {
			ydoc: room.ydoc,
			release() {
				if (released) return;
				released = true;
				room.refs -= 1;
				unloadIfClean(storageRef);
			},
		};
	};

	return {
		/** @internal Open from a runtime-derived private room manifest. */
		open,
		async [Symbol.asyncDispose]() {
			if (disposed) return;
			disposed = true;
			const failures = [...backgroundFailures];
			const openingResults = await Promise.allSettled(
				[...openingRooms.values()].map(({ promise }) => promise),
			);
			for (const result of openingResults) {
				if (result.status === 'rejected') failures.push(result.reason);
			}
			for (const room of liveRooms.values()) {
				try {
					room.sync[Symbol.dispose]();
				} catch (cause) {
					failures.push(cause);
				}
			}
			const results = await Promise.allSettled(pendingSaves.values());
			for (const result of results) {
				if (result.status === 'rejected') failures.push(result.reason);
			}
			for (const room of liveRooms.values()) room.ydoc.destroy();
			liveRooms.clear();
			openingRooms.clear();
			pendingSaves.clear();
			if (failures.length > 0) {
				throw new AggregateError(
					failures,
					'Document room catalog disposal failed',
				);
			}
		},
	};
}

export type DocumentRoomCatalog = ReturnType<typeof createDocumentRoomCatalog>;

/** @internal Bind opaque declarations to one authority-bound runtime. */
export function createDocumentNamespace<
	const TDefinitions extends DocumentDefinitions,
>({
	authorityKey,
	workspaceId,
	definitions,
	roomCatalog,
	assertRuntimeOpen,
	resolveManifest,
}: {
	authorityKey?: string;
	workspaceId: string;
	definitions: TDefinitions;
	roomCatalog: DocumentRoomCatalog;
	assertRuntimeOpen(): void;
	resolveManifest?: ResolveDocumentRoomManifest;
}): DocumentNamespace<TDefinitions> {
	if (!resolveManifest && authorityKey?.length === 0)
		throw new Error('Authority key must not be empty');
	if (!resolveManifest && authorityKey === undefined) {
		throw new Error('Document namespaces require an authority key or resolver');
	}
	assertSafeSegment(workspaceId, 'workspace id');
	assertPlainObject(definitions, 'workspace documents');

	return Object.freeze(
		Object.fromEntries(
			Object.entries(definitions).map(([storageKey, definition]) => {
				assertSafeSegment(storageKey, 'document storage key');
				if (!isDocumentDefinition(definition)) {
					throw new Error(
						`Workspace document '${storageKey}' must use document.*`,
					);
				}
				const metadata = inspectDocumentDefinition(definition);
				return [
					storageKey,
					Object.freeze({
						async open(paramsInput?: Record<string, unknown>) {
							assertRuntimeOpen();
							const params = validateParams(paramsInput ?? {}, metadata.params);
							const manifest = resolveManifest
								? await resolveManifest({
										workspaceId,
										declaration: storageKey,
										documentFormat: metadata.format,
										params,
									})
								: createDocumentRoomManifest({
										authorityKey: authorityKey as string,
										workspaceId,
										declaration: storageKey,
										documentFormat: metadata.format,
										params,
									});
							const session = await roomCatalog.open(manifest);
							let released = false;
							const leaseDisposers = new Set<() => void>();
							const assertLeaseOpen = () => {
								assertRuntimeOpen();
								if (released) throw new Error('Document lease is disposed');
							};
							const releaseLease = () => {
								if (released) return;
								released = true;
								const failures: unknown[] = [];
								for (const dispose of leaseDisposers) {
									try {
										dispose();
									} catch (cause) {
										failures.push(cause);
									}
								}
								leaseDisposers.clear();
								try {
									session.release();
								} catch (cause) {
									failures.push(cause);
								}
								if (failures.length > 0) {
									throw new AggregateError(
										failures,
										'Document lease disposal failed',
									);
								}
							};
							try {
								const content = metadata.attach(
									session.ydoc,
									assertLeaseOpen,
									(dispose) => leaseDisposers.add(dispose),
								);
								return {
									content,
									[Symbol.dispose]: releaseLease,
								};
							} catch (cause) {
								try {
									releaseLease();
								} catch (cleanupCause) {
									throw new AggregateError(
										[cause, cleanupCause],
										'Document opening and cleanup failed',
									);
								}
								throw cause;
							}
						},
					}),
				];
			}),
		),
	) as DocumentNamespace<TDefinitions>;
}

/** @internal Derive one durable room identity after declaration validation. */
export function createDocumentRoomManifest({
	authorityKey,
	workspaceId,
	declaration,
	documentFormat,
	params,
}: {
	authorityKey: string;
	workspaceId: string;
	declaration: string;
	documentFormat: string;
	params: Record<string, unknown>;
}): DocumentRoomManifest {
	const sortedParams = sortJson(params) as Record<string, unknown>;
	return {
		formatVersion: 1,
		storageRef: `document-${sha256Hex(
			canonicalJson({
				authorityKey,
				workspaceId,
				storageKey: declaration,
				format: documentFormat,
				params: sortedParams,
			}),
		)}`,
		workspaceId,
		declaration,
		documentFormat,
		params: sortedParams,
	};
}

/** @internal Validate declared params and derive the owner's room manifest. */
export function resolveDeclaredDocumentRoom({
	authorityKey,
	workspaceId,
	declaration,
	definition,
	params,
}: {
	authorityKey: string;
	workspaceId: string;
	declaration: string;
	definition: DocumentDefinition;
	params: Record<string, unknown>;
}): DocumentRoomManifest {
	const metadata = inspectDocumentDefinition(definition);
	return createDocumentRoomManifest({
		authorityKey,
		workspaceId,
		declaration,
		documentFormat: metadata.format,
		params: validateParams(params, metadata.params),
	});
}

function validateParams(
	input: Record<string, unknown>,
	schemas: Readonly<Record<string, import('typebox').TSchema>>,
): Record<string, unknown> {
	assertPlainObject(input, 'document params');
	if (Object.keys(input).length !== Object.keys(schemas).length) {
		throw new TypeError(
			'Document params must contain exactly the declared keys',
		);
	}
	const params: Record<string, unknown> = {};
	for (const [name, schema] of Object.entries(schemas)) {
		if (
			!Object.hasOwn(input, name) ||
			!isJsonValue(input[name]) ||
			!Value.Check(schema, input[name])
		) {
			throw new TypeError(`Invalid document param '${name}'`);
		}
		Object.defineProperty(params, name, {
			value: structuredClone(input[name]),
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
	return params;
}

function assertPlainObject(value: object, label: string): void {
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError(`${label} must be a plain object`);
	}
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJson);
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([key, child]) => [key, sortJson(child)]),
		);
	}
	return value;
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean'
	) {
		return true;
	}
	if (typeof value === 'number') return Number.isFinite(value);
	if (typeof value !== 'object' || ancestors.has(value)) return false;
	ancestors.add(value);
	const valid = Array.isArray(value)
		? value.every((child) => isJsonValue(child, ancestors))
		: (Object.getPrototypeOf(value) === Object.prototype ||
				Object.getPrototypeOf(value) === null) &&
			Object.values(value).every((child) => isJsonValue(child, ancestors));
	ancestors.delete(value);
	return valid;
}
