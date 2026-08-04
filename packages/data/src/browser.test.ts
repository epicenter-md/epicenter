/**
 * Browser adapter tests for the production topology: one page, one dedicated
 * worker, and one store. Transport generations below are successive sync
 * attachments within that page, never competing owners.
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { BrowserRequest } from './browser/protocol.js';
import {
	type BrowserWorkerStore,
	type MessagePortLike,
	serveBrowserEpicenter,
	settleBrowserCleanup,
} from './browser/worker.js';
import {
	type BrowserEpicenter,
	type ClientMessagePort,
	openBrowserEpicenter,
} from './browser.js';
import { createEpicenter } from './epicenter.js';
import { defineLens, defineTable, defineValue, optional } from './index.js';
import type { ExchangeRequest, ExchangeResponse } from './protocol/index.js';
import { openReplica } from './replica/index.js';

type MessageListener = (event: { data: never }) => void;

class FakeMessagePort {
	peer: FakeMessagePort | undefined;
	readonly sent: unknown[] = [];
	private readonly listeners = new Set<MessageListener>();
	closeCount = 0;

	postMessage(message: unknown): void {
		const cloned = structuredClone(message);
		this.sent.push(cloned);
		setTimeout(() => this.peer?.emit(cloned), 0);
	}

	addEventListener(_type: 'message', listener: MessageListener): void {
		this.listeners.add(listener);
	}

	start(): void {}

	close(): void {
		this.closeCount += 1;
		const peer = this.peer;
		this.peer = undefined;
		if (peer?.peer === this) peer.peer = undefined;
	}

	private emit(message: unknown): void {
		for (const listener of this.listeners) listener({ data: message as never });
	}
}

function createPortPair(): {
	page: ClientMessagePort;
	worker: MessagePortLike;
	pageMessages: unknown[];
	workerMessages: unknown[];
	sendWorkerMessage(message: unknown): void;
	pageCloseCount(): number;
} {
	const page = new FakeMessagePort();
	const worker = new FakeMessagePort();
	page.peer = worker;
	worker.peer = page;
	return {
		page: page as ClientMessagePort,
		worker: worker as MessagePortLike,
		pageMessages: page.sent,
		workerMessages: worker.sent,
		sendWorkerMessage: (message) => worker.postMessage(message),
		pageCloseCount: () => page.closeCount,
	};
}

function createStoreOwner({ disposeFailure }: { disposeFailure?: Error } = {}) {
	let activeStores = 0;
	let openCount = 0;
	let disposeCount = 0;

	async function openStore(): Promise<BrowserWorkerStore> {
		if (activeStores !== 0) throw new Error('SQLite owner is already active');
		activeStores += 1;
		openCount += 1;
		const rawDatabase = new Database(':memory:');
		const database = createBunSqliteAdapter(rawDatabase);
		const opened = openReplica({ database });
		if (opened.error !== null) throw opened.error;
		const epicenter = createEpicenter({
			replica: opened.data,
			database,
			dispose: () => rawDatabase.close(),
		});
		return {
			epicenter,
			replica: opened.data,
			async dispose() {
				try {
					await epicenter[Symbol.asyncDispose]();
				} finally {
					activeStores -= 1;
					disposeCount += 1;
				}
				if (disposeFailure !== undefined) throw disposeFailure;
			},
		};
	}

	return {
		openStore,
		get activeStores() {
			return activeStores;
		},
		get openCount() {
			return openCount;
		},
		get disposeCount() {
			return disposeCount;
		},
	};
}

async function setup({
	exchangeTimeoutMs,
	disposeFailure,
}: {
	exchangeTimeoutMs?: number;
	disposeFailure?: Error;
} = {}) {
	const owner = createStoreOwner({ disposeFailure });

	async function openControlledPage(): Promise<{
		epicenter: BrowserEpicenter;
		pageMessages: unknown[];
		workerMessages: unknown[];
		sendWorkerMessage(message: unknown): void;
	}> {
		const ports = createPortPair();
		serveBrowserEpicenter(ports.worker, {
			openStore: owner.openStore,
			...(exchangeTimeoutMs === undefined ? {} : { exchangeTimeoutMs }),
		});
		const epicenter = await openBrowserEpicenter({
			createWorker: () => ({ port: ports.page }),
		});
		return { epicenter, ...ports };
	}

	async function openPage(): Promise<BrowserEpicenter> {
		return (await openControlledPage()).epicenter;
	}

	return { openControlledPage, openPage, owner };
}

const notes = defineTable({
	fields: {
		title: field.string(),
		detail: optional(field.string()),
	},
});

const theme = defineValue({
	value: field.string(),
});

function bindTestData(epicenter: BrowserEpicenter) {
	return epicenter.bind(
		defineLens({
			namespace: 'so.epicenter.test',
			tables: { notes },
			values: { theme },
		}),
	);
}

test('page CRUD, subscriptions, scans, and values round-trip through its worker', async () => {
	const { openPage } = await setup();
	await using epicenter = await openPage();
	const data = bindTestData(epicenter);
	const invalidated: string[] = [];
	const unsubscribe = data.tables.notes.subscribe((invalidation) => {
		if (invalidation.scope === 'rows') invalidated.push(...invalidation.rowIds);
	});

	const created = await data.tables.notes.create({ title: 'First' });
	await waitFor(() => invalidated.includes(created.id));
	expect(expectOk(await data.tables.notes.get(created.id))).toEqual(created);
	expectOk(
		await data.tables.notes.patch(created.id, {
			title: 'Updated',
			detail: 'RPC',
		}),
	);
	expect((await data.tables.notes.scan()).rows).toEqual([
		{ id: created.id, title: 'Updated', detail: 'RPC' },
	]);
	await data.values.theme.set('dark');
	expect(expectOk(await data.values.theme.get())).toBe('dark');
	await data.values.theme.unset();
	expect(expectOk(await data.values.theme.get())).toBeUndefined();
	expect(await data.tables.notes.delete(created.id)).toBe(true);
	unsubscribe();
});

test('two document handles in one page persist updates and revoke together', async () => {
	const { openPage } = await setup();
	await using epicenter = await openPage();
	const lens = bindTestData(epicenter).tables.notes;
	const row = await lens.create({ title: 'Document' });
	const first = await lens.openDocument(row.id);
	const second = await lens.openDocument(row.id);

	first.get('content').insert(0, 'one owner');
	await first.whenDurable();
	await waitFor(() => second.get('content').toString() === 'one owner');
	await lens.delete(row.id);
	await waitFor(() => {
		try {
			second.get('content');
			return false;
		} catch {
			return true;
		}
	});
	expect(() => first.get('content')).toThrow('revoked');
	expect(() => second.get('content')).toThrow('revoked');
	await first[Symbol.asyncDispose]();
	await second[Symbol.asyncDispose]();
});

test('a different principal is refused without replacing the active transport', async () => {
	const { openPage } = await setup();
	await using epicenter = await openPage();
	let activeExchanges = 0;
	let refusedExchanges = 0;

	expectOk(
		await epicenter.attachSync({
			deploymentId: 'https://example.test/',
			principalId: 'alice',
			exchange(request) {
				activeExchanges += 1;
				return acknowledge(request);
			},
		}),
	);
	const beforeRefusal = activeExchanges;
	const refusal = expectErr(
		await epicenter.attachSync({
			deploymentId: 'https://example.test/',
			principalId: 'bob',
			exchange(request) {
				refusedExchanges += 1;
				return acknowledge(request);
			},
		}),
	);
	expect(refusal.name).toBe('WrongAttachment');
	await bindTestData(epicenter).tables.notes.create({
		title: 'Still attached',
	});
	await waitFor(() => activeExchanges > beforeRefusal);
	expect(refusedExchanges).toBe(0);
});

test('a stalled network attachment does not block local RPC or disposal', async () => {
	const { openPage } = await setup({ exchangeTimeoutMs: 60_000 });
	const epicenter = await openPage();
	let exchangeStarted = false;
	const attachment = epicenter
		.attachSync({
			deploymentId: 'https://example.test/',
			principalId: 'alice',
			exchange() {
				exchangeStarted = true;
				return new Promise<ExchangeResponse>(() => undefined);
			},
		})
		.then(
			() => undefined,
			(cause: unknown) => cause,
		);
	await waitFor(() => exchangeStarted);
	const row = await settleWithin(
		bindTestData(epicenter).tables.notes.create({
			title: 'Local remains live',
		}),
		1_000,
	);
	expect(row.title).toBe('Local remains live');
	await settleWithin(epicenter[Symbol.asyncDispose](), 1_000);
	expect(await attachment).toBeInstanceOf(Error);
});

test('a newer attachment generation cancels a stalled predecessor', async () => {
	const { openPage } = await setup({ exchangeTimeoutMs: 60_000 });
	const epicenter = await openPage();
	let stalledExchangeStarted = false;
	const stalled = epicenter.attachSync({
		deploymentId: 'https://example.test/',
		principalId: 'alice',
		exchange() {
			stalledExchangeStarted = true;
			return new Promise<ExchangeResponse>(() => undefined);
		},
	});
	await waitFor(() => stalledExchangeStarted);
	let replacementExchanges = 0;

	expectOk(
		await settleWithin(
			epicenter.attachSync({
				deploymentId: 'https://example.test/',
				principalId: 'alice',
				exchange(request) {
					replacementExchanges += 1;
					return acknowledge(request);
				},
			}),
			1_000,
		),
	);
	expect(expectErr(await stalled).name).toBe('TransportFailed');
	const beforeWrite = replacementExchanges;
	await bindTestData(epicenter).tables.notes.create({
		title: 'New generation',
	});
	await waitFor(() => replacementExchanges > beforeWrite);
	await epicenter[Symbol.asyncDispose]();
});

test('timed-out exchanges stay serialized within their attachment generation', async () => {
	const { openPage } = await setup({ exchangeTimeoutMs: 10 });
	await using epicenter = await openPage();
	const requests: ExchangeRequest[] = [];
	let activeExchanges = 0;
	let maximumActiveExchanges = 0;
	let releaseStall: (() => void) | undefined;
	let stallNext = false;

	expectOk(
		await epicenter.attachSync({
			deploymentId: 'https://example.test/',
			principalId: 'alice',
			async exchange(request) {
				requests.push(request);
				activeExchanges += 1;
				maximumActiveExchanges = Math.max(
					maximumActiveExchanges,
					activeExchanges,
				);
				try {
					if (stallNext) {
						stallNext = false;
						await new Promise<void>((resolve) => {
							releaseStall = resolve;
						});
					}
					return acknowledge(request);
				} finally {
					activeExchanges -= 1;
				}
			},
		}),
	);
	const beforeWrite = requests.length;
	stallNext = true;
	await bindTestData(epicenter).tables.notes.create({
		title: 'Retry in order',
	});
	await waitFor(() => releaseStall !== undefined);
	await Bun.sleep(30);
	expect(maximumActiveExchanges).toBe(1);
	expect(requests).toHaveLength(beforeWrite + 1);
	releaseStall?.();
	await waitFor(
		() =>
			requests.length >= beforeWrite + 2 &&
			epicenter.syncStatus.state === 'idle',
	);
	expect(requests.at(-1)).toEqual(requests.at(-2));
	expect(maximumActiveExchanges).toBe(1);
});

test('transport cancellation correlates request id and attachment generation', async () => {
	const { openControlledPage } = await setup({ exchangeTimeoutMs: 1_000 });
	const page = await openControlledPage();
	await using epicenter = page.epicenter;
	let releaseExchange: (() => void) | undefined;
	let stallNext = false;
	expectOk(
		await epicenter.attachSync({
			deploymentId: 'https://example.test/',
			principalId: 'alice',
			async exchange(request) {
				if (stallNext) {
					stallNext = false;
					await new Promise<void>((resolve) => {
						releaseExchange = resolve;
					});
				}
				return acknowledge(request);
			},
		}),
	);
	stallNext = true;
	await bindTestData(epicenter).tables.notes.create({ title: 'Correlate' });
	await waitFor(() => releaseExchange !== undefined);
	const request = lastMessageOfType(page.workerMessages, 'transport-request');
	if (
		request === undefined ||
		typeof request.transportId !== 'number' ||
		typeof request.transportKey !== 'number'
	)
		throw new Error('Expected a correlated transport request');
	page.sendWorkerMessage({
		type: 'transport-cancel',
		transportId: request.transportId + 1,
		transportKey: request.transportKey,
	});
	page.sendWorkerMessage({
		type: 'transport-cancel',
		transportId: request.transportId,
		transportKey: request.transportKey + 1,
	});
	releaseExchange?.();
	await waitFor(
		() =>
			lastMessageOfType(page.pageMessages, 'transport-result')?.transportId ===
			request.transportId,
	);
});

test('browser cleanup runs every stage and preserves one failure', async () => {
	const failure = new Error('first cleanup failed');
	const stages: string[] = [];
	const cleanup = settleBrowserCleanup({
		stages: [
			() => {
				stages.push('first');
				throw failure;
			},
			() => {
				stages.push('second');
			},
			() => {
				stages.push('third');
			},
		],
		message: 'unused for one failure',
	});

	await expect(cleanup).rejects.toBe(failure);
	expect(stages).toEqual(['first', 'second', 'third']);
});

test('browser cleanup aggregates multiple failures after every stage', async () => {
	const first = new Error('first cleanup failed');
	const second = new Error('second cleanup failed');
	const stages: string[] = [];
	const failure = await settleBrowserCleanup({
		stages: [
			() => {
				stages.push('first');
				throw first;
			},
			() => {
				stages.push('middle');
			},
			() => {
				stages.push('last');
				throw second;
			},
		],
		message: 'Browser cleanup failed',
	}).catch((cause: unknown) => cause);

	expect(stages).toEqual(['first', 'middle', 'last']);
	expect(failure).toBeInstanceOf(AggregateError);
	expect((failure as AggregateError).errors).toEqual([first, second]);
});

test('late store resolution is disposed before disconnect is acknowledged', async () => {
	const ports = createPortPair();
	const owner = createStoreOwner();
	let openingSignal: AbortSignal | undefined;
	const lateStore = Promise.withResolvers<BrowserWorkerStore>();
	serveBrowserEpicenter(ports.worker, {
		openStore({ signal }) {
			openingSignal = signal;
			return lateStore.promise;
		},
	});
	ports.page.postMessage({
		type: 'request',
		id: 1,
		operation: { kind: 'open' },
	});
	await waitFor(() => openingSignal !== undefined);
	ports.page.postMessage({
		type: 'request',
		id: 2,
		operation: { kind: 'disconnect' },
	});
	await waitFor(() => openingSignal?.aborted === true);
	await Bun.sleep(5);
	expect(hasResult(ports.workerMessages, 2)).toBe(false);

	lateStore.resolve(await owner.openStore());
	await waitFor(() => hasResult(ports.workerMessages, 2));
	expect(owner.activeStores).toBe(0);
	expect(owner.disposeCount).toBe(1);
});

test('store disposal failure releases ownership and permits a later page', async () => {
	const disposeFailure = new Error('Injected store disposal failure');
	const { openPage, owner } = await setup({ disposeFailure });
	const first = await openPage();

	await expect(first[Symbol.asyncDispose]()).rejects.toThrow(
		disposeFailure.message,
	);
	expect(owner.activeStores).toBe(0);
	expect(owner.disposeCount).toBe(1);

	const second = await openPage();
	expect(owner.activeStores).toBe(1);
	await expect(second[Symbol.asyncDispose]()).rejects.toThrow(
		disposeFailure.message,
	);
	expect(owner.activeStores).toBe(0);
});

test('initial store failure rejects open and closes the page worker once', async () => {
	const ports = createPortPair();
	const failure = new Error('Injected initial store failure');
	serveBrowserEpicenter(ports.worker, {
		openStore: () => Promise.reject(failure),
	});

	await expect(
		openBrowserEpicenter({
			createWorker: () => ({ port: ports.page }),
		}),
	).rejects.toThrow(failure.message);
	expect(ports.pageCloseCount()).toBe(1);
});

test('document disposal aggregates persistence and close failures', async () => {
	const ports = createPortPair();
	const emptyUpdate = Y.encodeStateAsUpdateV2(new Y.Doc());
	ports.worker.addEventListener('message', ({ data }) => {
		const request = data as BrowserRequest;
		if (request.type !== 'request') return;
		switch (request.operation.kind) {
			case 'document-open':
				ports.worker.postMessage({
					type: 'result',
					id: request.id,
					value: { documentId: 1, update: emptyUpdate },
				});
				return;
			case 'document-update':
				ports.worker.postMessage({
					type: 'error',
					id: request.id,
					name: 'PersistenceError',
					message: 'Injected persistence failure',
				});
				return;
			case 'document-close':
				ports.worker.postMessage({
					type: 'error',
					id: request.id,
					name: 'CloseError',
					message: 'Injected close failure',
				});
				return;
			default:
				ports.worker.postMessage({
					type: 'result',
					id: request.id,
					value: undefined,
				});
		}
	});
	const epicenter = await openBrowserEpicenter({
		createWorker: () => ({ port: ports.page }),
	});
	const document = await bindTestData(epicenter).tables.notes.openDocument(
		'000000000000000000000000',
	);

	document.get('content').insert(0, 'will fail');
	const failure = await document[Symbol.asyncDispose]().catch(
		(cause: unknown) => cause,
	);
	expect(failure).toBeInstanceOf(AggregateError);
	expect((failure as AggregateError).errors).toEqual([
		expect.objectContaining({
			message:
				'Row document persistence failed; the handle is closed to protect durable state',
		}),
		expect.objectContaining({ message: 'Injected close failure' }),
	]);
	await epicenter[Symbol.asyncDispose]();
});

test('disposing the page releases its store before another page opens', async () => {
	const { openPage, owner } = await setup();
	const first = await openPage();
	expect(owner.activeStores).toBe(1);
	await first[Symbol.asyncDispose]();
	expect(owner.activeStores).toBe(0);
	expect(owner.disposeCount).toBe(1);
	await using second = await openPage();
	expect(second).toBeDefined();
	expect(owner.activeStores).toBe(1);
	expect(owner.openCount).toBe(2);
});

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() > deadline)
			throw new Error('Timed out waiting for browser RPC');
		await Bun.sleep(5);
	}
}

async function settleWithin<TValue>(
	promise: Promise<TValue>,
	timeoutMs: number,
): Promise<TValue> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new Error(`Operation exceeded ${timeoutMs}ms`)),
			timeoutMs,
		);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function acknowledge(request: ExchangeRequest): ExchangeResponse {
	return {
		...(request.batch === undefined
			? {}
			: {
					receipt: {
						seq: request.batch.seq,
						digest: request.batch.digest,
						appliedThrough: request.after,
					},
				}),
		through: request.after,
		facts: [],
		next: null,
	};
}

function hasResult(messages: unknown[], id: number): boolean {
	return messages.some(
		(message) =>
			typeof message === 'object' &&
			message !== null &&
			'type' in message &&
			message.type === 'result' &&
			'id' in message &&
			message.id === id,
	);
}

function lastMessageOfType(
	messages: unknown[],
	type: string,
): (Record<string, unknown> & { type: string }) | undefined {
	return messages.findLast(
		(message): message is Record<string, unknown> & { type: string } =>
			typeof message === 'object' &&
			message !== null &&
			'type' in message &&
			message.type === type,
	);
}
