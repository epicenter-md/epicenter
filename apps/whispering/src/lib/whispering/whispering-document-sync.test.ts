/**
 * Whispering Document Sync Binding Tests
 *
 * Proves that the application runtime keeps document room identity private,
 * binds signed-in rooms through auth-owned WebSockets, and leaves signed-out
 * rooms local. The workspace runtime separately proves local replay precedes
 * this attachment.
 */

import { expect, test } from 'bun:test';
import type { SyncAuthClient } from '@epicenter/auth';
import { asNodeId } from '@epicenter/workspace';
import { IDBFactory } from 'fake-indexeddb';
import { openWhisperingApplication } from './whispering.active';
import { createWhisperingBrowserRuntime } from './whispering.browser-runtime';

type WorkspaceAuth = Pick<
	SyncAuthClient,
	'state' | 'deployment' | 'fetch' | 'openWebSocket' | 'onStateChange'
>;

function createAuth({
	state,
	onOpenWebSocket = () => undefined,
	onSubscribe = () => undefined,
	onUnsubscribe = () => undefined,
}: {
	state: SyncAuthClient['state'];
	onOpenWebSocket?(url: string): void;
	onSubscribe?(): void;
	onUnsubscribe?(): void;
}): WorkspaceAuth {
	return {
		state,
		deployment: { kind: 'hosted', baseURL: 'https://api.example.com' },
		fetch: globalThis.fetch.bind(globalThis),
		async openWebSocket(url) {
			onOpenWebSocket(String(url));
			throw new Error('offline test transport');
		},
		onStateChange() {
			onSubscribe();
			return onUnsubscribe;
		},
	};
}

async function withIndexedDb<TResult>(run: () => Promise<TResult>) {
	const previous = globalThis.indexedDB;
	globalThis.indexedDB = new IDBFactory();
	try {
		return await run();
	} finally {
		globalThis.indexedDB = previous;
	}
}

test('signed-in documents attach the private room and clean up reconnect subscription', async () => {
	await withIndexedDb(async () => {
		const urls: string[] = [];
		let subscriptions = 0;
		let unsubscriptions = 0;
		const application = await openWhisperingApplication({
			createRuntime: (onRecordsChanged) =>
				createWhisperingBrowserRuntime({
					auth: createAuth({
						state: {
							status: 'signed-in',
							principalId: 'principal-test',
						} as WorkspaceAuth['state'],
						onOpenWebSocket: (url) => urls.push(url),
						onSubscribe: () => subscriptions++,
						onUnsubscribe: () => unsubscriptions++,
					}),
					nodeId: asNodeId('node-test'),
					onRecordsChanged,
				}),
			defaultTranscriptionService: 'OpenAI',
		});
		try {
			const settings = await application.whispering.documents.settings.open();
			expect(urls).toHaveLength(1);
			expect(urls[0]).toMatch(
				/^wss:\/\/api\.example\.com\/api\/rooms\/document-[a-f0-9]{64}\?nodeId=node-test$/,
			);
			expect(subscriptions).toBe(1);
			settings[Symbol.dispose]();
			for (let attempt = 0; attempt < 100 && unsubscriptions === 0; attempt++) {
				await Bun.sleep(0);
			}
			expect(unsubscriptions).toBe(1);
		} finally {
			await application[Symbol.asyncDispose]();
		}
	});
});

test('signed-out documents remain local', async () => {
	await withIndexedDb(async () => {
		let socketOpens = 0;
		let subscriptions = 0;
		const application = await openWhisperingApplication({
			createRuntime: (onRecordsChanged) =>
				createWhisperingBrowserRuntime({
					auth: createAuth({
						state: { status: 'signed-out' },
						onOpenWebSocket: () => socketOpens++,
						onSubscribe: () => subscriptions++,
					}),
					nodeId: asNodeId('node-test'),
					onRecordsChanged,
				}),
			defaultTranscriptionService: 'OpenAI',
		});
		try {
			await using settings =
				await application.whispering.documents.settings.open();
			void settings;
			expect(socketOpens).toBe(0);
			expect(subscriptions).toBe(0);
		} finally {
			await application[Symbol.asyncDispose]();
		}
	});
});
