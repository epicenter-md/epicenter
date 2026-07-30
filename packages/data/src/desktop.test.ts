/**
 * Desktop Data Adapter Lifecycle Tests
 *
 * Verifies the desktop proxy releases host state when opening its observation
 * carrier fails after the host has registered the surface.
 *
 * Key behaviors:
 * - Initial carrier failure rejects the opener
 * - The opened surface is disconnected before the rejection reaches the caller
 */

import { expect, test } from 'bun:test';

import { type ObservationSocket, openDesktopEpicenter } from './desktop.js';
import type { DesktopRequest } from './desktop-protocol.js';

test('a failed initial carrier releases the surface opened by the adapter', async () => {
	const operations: string[] = [];

	const opened = openDesktopEpicenter({
		baseUrl: 'http://epicenter.test',
		async fetch(_input, init) {
			const request = JSON.parse(String(init?.body)) as DesktopRequest;
			operations.push(request.operation.kind);
			return Response.json({ data: null, error: null });
		},
		createObservationSocket: () => new ClosingSocket(),
	});

	await expect(opened).rejects.toThrow(
		'Desktop Epicenter could not open its observation carrier',
	);
	expect(operations).toEqual(['open', 'disconnect']);
});

test('a dial that throws reaches the caller with its reason intact', async () => {
	const operations: string[] = [];
	const dialFailure = new Error(
		'Desktop Epicenter requires WebSocket for live data observation',
	);

	const opened = openDesktopEpicenter({
		baseUrl: 'http://epicenter.test',
		async fetch(_input, init) {
			const request = JSON.parse(String(init?.body)) as DesktopRequest;
			operations.push(request.operation.kind);
			return Response.json({ data: null, error: null });
		},
		createObservationSocket: () => {
			throw dialFailure;
		},
	});

	const failure = await opened.then(
		() => undefined,
		(cause: unknown) => cause as Error,
	);
	// Before the carrier opened atomically this was a generic sentence with no
	// `cause`, so the one thing a person could act on, that this environment has
	// no `WebSocket`, was the one thing that never arrived.
	expect(failure?.message).toBe(
		'Desktop Epicenter could not open its observation carrier: Observation carrier could not dial: Desktop Epicenter requires WebSocket for live data observation',
	);
	expect((failure?.cause as Error | undefined)?.cause).toBe(dialFailure);
	expect(operations).toEqual(['open', 'disconnect']);
});

class ClosingSocket implements ObservationSocket {
	readonly listeners = new Map<
		string,
		((event: { data: unknown }) => void)[]
	>();

	constructor() {
		queueMicrotask(() => this.emit('close'));
	}

	addEventListener(type: 'open', listener: () => void): void;
	addEventListener(type: 'close', listener: () => void): void;
	addEventListener(type: 'error', listener: () => void): void;
	addEventListener(
		type: 'message',
		listener: (event: { data: unknown }) => void,
	): void;
	addEventListener(
		type: string,
		listener: (() => void) | ((event: { data: unknown }) => void),
	): void {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}

	close(): void {}

	private emit(type: string): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener({ data: undefined });
		}
	}
}
