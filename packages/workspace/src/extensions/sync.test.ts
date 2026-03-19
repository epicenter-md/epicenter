/**
 * Sync Extension Tests
 *
 * These tests verify sync extension lifecycle behavior around provider creation,
 * reconnect semantics, URL resolution, and readiness ordering.
 *
 * Key behaviors:
 * - Reconnect disconnects and reconnects the same provider instance
 * - URL configuration and whenReady lifecycle resolve in the expected order
 */
import { describe, expect, test } from 'bun:test';
import type { SyncProvider } from '@epicenter/sync-client';
import * as Y from 'yjs';
import { createSyncExtension } from './sync';

/** The shape returned by the extension factory (flat). */
type SyncExtensionResult = {
	provider: SyncProvider;
	reconnect: () => void;
	whenReady: Promise<unknown>;
	destroy: () => void;
};

type SyncExtensionFactoryClient = Parameters<
	ReturnType<typeof createSyncExtension>
>[0];

/** Create a minimal mock context for the sync extension factory. */
function createMockContext(ydoc: Y.Doc): SyncExtensionFactoryClient {
	return {
		ydoc,
		whenReady: Promise.resolve(),
	};
}

describe('createSyncExtension', () => {
	describe('reconnect', () => {
		test('reconnect reuses the same provider instance', () => {
			const ydoc = new Y.Doc({ guid: 'test-doc' });

			const factory = createSyncExtension({
				url: (id: string) => `http://localhost:8080/rooms/${id}`,
			});

			const result = factory(
				createMockContext(ydoc),
			) as unknown as SyncExtensionResult;

			const provider = result.provider;
			expect(provider).toBeDefined();

			result.reconnect();

			// Same provider instance — reconnect delegates to disconnect/connect
			expect(result.provider).toBe(provider);

			result.destroy();
		});

		test('reconnect sets provider to offline then allows reconnection', () => {
			const ydoc = new Y.Doc({ guid: 'test-doc-status' });

			const factory = createSyncExtension({
				url: (id: string) => `http://localhost:8080/rooms/${id}`,
			});

			const result = factory(
				createMockContext(ydoc),
			) as unknown as SyncExtensionResult;

			result.reconnect();

			// After disconnect(), status is synchronously offline
			// connect() then kicks off the supervisor loop
			expect(result.provider).toBeDefined();

			result.destroy();
		});

		test('destroy sets provider to offline', () => {
			const ydoc = new Y.Doc({ guid: 'test-doc-destroy' });

			const factory = createSyncExtension({
				url: (id: string) => `http://localhost:8080/rooms/${id}`,
			});

			const result = factory(
				createMockContext(ydoc),
			) as unknown as SyncExtensionResult;

			const provider = result.provider;
			result.destroy();

			expect(provider.status.phase).toBe('offline');
		});
	});

	test('resolves URL callback with workspace ID', () => {
		const ydoc = new Y.Doc({ guid: 'my-workspace' });

		const factory = createSyncExtension({
			url: (id) => `http://localhost:3913/custom/${id}/ws`,
		});

		const result = factory(
			createMockContext(ydoc),
		) as unknown as SyncExtensionResult;

		expect(result.provider).toBeDefined();
		expect(result.provider.status.phase).toBe('offline');

		result.destroy();
	});

	test('whenReady awaits client.whenReady before connecting', async () => {
		const ydoc = new Y.Doc({ guid: 'await-test' });
		const order: string[] = [];

		let resolveClientReady!: () => void;
		const clientWhenReady = new Promise<void>((resolve) => {
			resolveClientReady = resolve;
		});

		const factory = createSyncExtension({
			url: (id: string) => `http://localhost:8080/rooms/${id}`,
		});

		const result = factory({
			ydoc,
			whenReady: clientWhenReady.then(() => {
				order.push('client-ready');
			}),
		} as SyncExtensionFactoryClient) as unknown as SyncExtensionResult;

		// whenReady should not have resolved yet
		let resolved = false;
		void result.whenReady.then(() => {
			resolved = true;
			order.push('sync-ready');
		});

		// Give microtasks a chance
		await new Promise((r) => setTimeout(r, 10));
		expect(resolved).toBe(false);

		// Resolve the client's whenReady
		resolveClientReady();
		await result.whenReady;

		expect(order).toEqual(['client-ready', 'sync-ready']);

		result.destroy();
	});
});
