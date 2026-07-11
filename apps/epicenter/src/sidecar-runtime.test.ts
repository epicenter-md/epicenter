/**
 * Bun Sidecar Runtime Tests
 *
 * Verifies the versioned Rust-to-Bun boot boundary and the shutdown owner that
 * ties Bun to its Rust parent's stdin pipe.
 *
 * Key behaviors:
 * - Boot frames are exact, versioned, and mode-specific
 * - Ready frames have one stable machine-readable stdout shape
 * - Signals and parent-pipe EOF stop the server before disposing host state
 */

import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import {
	createReadyFrame,
	type ParentPipe,
	PRODUCTION_PORT,
	parseBootFrame,
	parseRuntimeMode,
	SIDECAR_PROTOCOL_VERSION,
	superviseSidecar,
	watchParentPipe,
} from './sidecar-runtime.ts';

const TOKEN = 'valid_base64url-token';

function bootFrame(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		type: 'boot',
		protocolVersion: SIDECAR_PROTOCOL_VERSION,
		token: TOKEN,
		port: PRODUCTION_PORT,
		...overrides,
	});
}

function setup() {
	const events: string[] = [];
	const parentClosed = Promise.withResolvers<void>();
	const signals = new EventEmitter();
	const parentPipe: ParentPipe = {
		bootLine: Promise.resolve(bootFrame()),
		closed: parentClosed.promise,
		async cancel() {
			events.push('pipe.cancel');
		},
	};
	const server = {
		async stop(closeActiveConnections?: boolean) {
			events.push(`server.stop:${String(closeActiveConnections)}`);
		},
	};
	const host = {
		async [Symbol.asyncDispose]() {
			events.push('host.dispose');
		},
	};
	return { events, host, parentClosed, parentPipe, server, signals };
}

describe('runtime mode', () => {
	test('source and compiled argv shapes select the Rust-supplied mode', () => {
		expect(
			parseRuntimeMode([
				'/path/to/bun',
				'/app/src/main.ts',
				'--runtime-mode=production',
			]),
		).toBe('production');
		expect(
			parseRuntimeMode(['/app/epicenter-bun', '--runtime-mode=development']),
		).toBe('development');
	});

	test('missing, unknown, and additional arguments are rejected', () => {
		expect(() => parseRuntimeMode(['/app/epicenter-bun'])).toThrow(
			'exactly one',
		);
		expect(() =>
			parseRuntimeMode(['/app/epicenter-bun', '--runtime-mode=test']),
		).toThrow('production or --runtime-mode=development');
		expect(() =>
			parseRuntimeMode([
				'/app/epicenter-bun',
				'--runtime-mode=production',
				'--runtime-mode=development',
			]),
		).toThrow('exactly one');
	});
});

describe('boot protocol', () => {
	test('malformed JSON and non-object frames are rejected', () => {
		expect(() => parseBootFrame('{', 'production')).toThrow('valid JSON');
		expect(() => parseBootFrame('[]', 'production')).toThrow('JSON object');
	});

	test('missing and additional frame properties are rejected', () => {
		expect(() =>
			parseBootFrame(
				JSON.stringify({
					type: 'boot',
					protocolVersion: SIDECAR_PROTOCOL_VERSION,
					token: TOKEN,
				}),
				'production',
			),
		).toThrow('contain exactly');
		expect(() =>
			parseBootFrame(bootFrame({ unexpected: true }), 'production'),
		).toThrow('contain exactly');
	});

	test('unknown protocol versions are rejected', () => {
		expect(() =>
			parseBootFrame(bootFrame({ protocolVersion: 2 }), 'production'),
		).toThrow('Unsupported boot protocol version: 2');
	});

	test('invalid token types and non-base64url tokens are rejected', () => {
		for (const token of ['', 'contains spaces', 'padded=', 123, null]) {
			expect(() => parseBootFrame(bootFrame({ token }), 'production')).toThrow(
				'non-empty base64url',
			);
		}
	});

	test('non-integer, privileged, and out-of-range ports are rejected', () => {
		for (const port of [1_023, 65_536, 39_130.5, '39130', null]) {
			expect(() => parseBootFrame(bootFrame({ port }), 'development')).toThrow(
				'integer from 1024 through 65535',
			);
		}
	});

	test('production accepts only the fixed production port', () => {
		expect(parseBootFrame(bootFrame(), 'production').port).toBe(
			PRODUCTION_PORT,
		);
		expect(() =>
			parseBootFrame(bootFrame({ port: PRODUCTION_PORT + 1 }), 'production'),
		).toThrow(`Production must bind port ${PRODUCTION_PORT}`);
	});

	test('development accepts any non-privileged valid port passed by Rust', () => {
		expect(parseBootFrame(bootFrame({ port: 1_024 }), 'development').port).toBe(
			1_024,
		);
		expect(
			parseBootFrame(bootFrame({ port: 65_535 }), 'development').port,
		).toBe(65_535);
	});

	test('ready frames contain exactly the versioned readiness contract', () => {
		expect(createReadyFrame(PRODUCTION_PORT)).toEqual({
			type: 'ready',
			protocolVersion: 1,
			port: PRODUCTION_PORT,
		});
	});
});

describe('parent pipe', () => {
	test('the first complete line is the boot frame and later EOF remains observable', async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('first half'));
				controller.enqueue(new TextEncoder().encode(' second half\nignored'));
				controller.close();
			},
		});
		const parentPipe = watchParentPipe(stream);

		expect(await parentPipe.bootLine).toBe('first half second half');
		await expect(parentPipe.closed).resolves.toBeUndefined();
	});

	test('EOF before a newline rejects the incomplete boot frame', async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(bootFrame()));
				controller.close();
			},
		});
		const parentPipe = watchParentPipe(stream);

		await expect(parentPipe.bootLine).rejects.toThrow('complete boot line');
	});
});

describe('shutdown', () => {
	test('SIGTERM stops the server, disposes the host, and releases stdin in order', async () => {
		const { events, host, parentPipe, server, signals } = setup();
		const supervised = superviseSidecar({
			server,
			host,
			parentPipe,
			signals,
		});

		signals.emit('SIGTERM');
		await supervised;

		expect(events).toEqual(['server.stop:true', 'host.dispose', 'pipe.cancel']);
	});

	test('parent-pipe EOF performs the same complete shutdown', async () => {
		const { events, host, parentClosed, parentPipe, server, signals } = setup();
		const supervised = superviseSidecar({
			server,
			host,
			parentPipe,
			signals,
		});

		parentClosed.resolve();
		await supervised;

		expect(events).toEqual(['server.stop:true', 'host.dispose', 'pipe.cancel']);
	});
});
