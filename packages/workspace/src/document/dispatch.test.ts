/**
 * Tests for the live-device dispatch module.
 *
 * Covers the four pieces that make up dispatch:
 *
 *   - `deriveDispatchUrl`: ws -> http URL transformation.
 *   - `getOnlineInstallationIds`: awareness-derived liveness readout.
 *   - `runInboundDispatch`: recipient-side text-frame handler that runs
 *     the local action registry and emits a `dispatch_response`.
 *   - `dispatch`: caller-side HTTP wrapper, error decoding, abort
 *     handling.
 *
 * Network IO is faked with `globalThis.fetch` overrides; awareness uses
 * the real y-protocols Awareness class against a throwaway Y.Doc.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { expectErr, expectOk } from '@epicenter/test-utils/result';
import Type from 'typebox';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { defineMutation, defineQuery } from '../shared/actions.js';
import {
	type ActionInput,
	type ActionOutput,
	DispatchError,
	deriveDispatchUrl,
	dispatch,
	getOnlineInstallationIds,
	runInboundDispatch,
	typedDispatch,
} from './dispatch.js';

// ════════════════════════════════════════════════════════════════════════════
// URL derivation
// ════════════════════════════════════════════════════════════════════════════

describe('deriveDispatchUrl', () => {
	test('wss URLs become https with /dispatch appended', () => {
		expect(deriveDispatchUrl('wss://api.example.com/rooms/abc')).toBe(
			'https://api.example.com/rooms/abc/dispatch',
		);
	});
	test('ws URLs become http with /dispatch appended', () => {
		expect(deriveDispatchUrl('ws://localhost:8787/rooms/wid')).toBe(
			'http://localhost:8787/rooms/wid/dispatch',
		);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// getOnlineInstallationIds (spec §3.7 reader)
// ════════════════════════════════════════════════════════════════════════════

describe('getOnlineInstallationIds', () => {
	test('returns each peer install once, sorted, with self excluded', () => {
		const doc = new Y.Doc();
		const awareness = new Awareness(doc);
		// Self-state under our own clientID; should be excluded.
		awareness.setLocalStateField('liveness', { installationId: 'self' });
		// Simulate two remote peers, one with a duplicate (multi-tab same-install).
		awareness.states.set(101, { liveness: { installationId: 'R_phone' } });
		awareness.states.set(102, { liveness: { installationId: 'R_laptop' } });
		awareness.states.set(103, { liveness: { installationId: 'R_phone' } });
		// Peer without a liveness sub-field is skipped.
		awareness.states.set(104, { cursor: { x: 1, y: 2 } });

		const devices = getOnlineInstallationIds({
			awareness,
			selfInstallationId: 'self',
		});

		expect(devices).toEqual([
			{ installationId: 'R_laptop' },
			{ installationId: 'R_phone' },
		]);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// runInboundDispatch (recipient side)
// ════════════════════════════════════════════════════════════════════════════

describe('runInboundDispatch', () => {
	test('happy path: runs action and Ok-wraps the result', async () => {
		const actions = {
			noop_ping: defineQuery({ handler: () => 'pong' }),
		};
		const inbound = JSON.stringify({
			type: 'dispatch_inbound',
			id: 'i7',
			from: 'R_laptop',
			action: 'noop_ping',
			input: undefined,
		});

		const response = await runInboundDispatch({ rawFrame: inbound, actions });

		expect(response).not.toBeNull();
		const parsed = JSON.parse(response!);
		expect(parsed.type).toBe('dispatch_response');
		expect(parsed.id).toBe('i7');
		expect(parsed.result.data).toBe('pong');
	});

	test('unknown action: ActionNotFound response', async () => {
		const inbound = JSON.stringify({
			type: 'dispatch_inbound',
			id: 'i8',
			from: 'R_laptop',
			action: 'missing_action',
			input: undefined,
		});

		const response = await runInboundDispatch({
			rawFrame: inbound,
			actions: {},
		});

		const parsed = JSON.parse(response!);
		expect(parsed.result.error.name).toBe('ActionNotFound');
		expect(parsed.result.error.action).toBe('missing_action');
	});

	test('handler throws: ActionFailed with serialized cause string', async () => {
		const actions = {
			boom: defineMutation({
				handler: () => {
					throw new Error('handler exploded');
				},
			}),
		};
		const inbound = JSON.stringify({
			type: 'dispatch_inbound',
			id: 'i9',
			from: 'R_laptop',
			action: 'boom',
			input: undefined,
		});

		const response = await runInboundDispatch({ rawFrame: inbound, actions });
		const parsed = JSON.parse(response!);
		expect(parsed.result.error.name).toBe('ActionFailed');
		expect(parsed.result.error.action).toBe('boom');
		expect(typeof parsed.result.error.cause).toBe('string');
		expect(parsed.result.error.cause).toBe('handler exploded');
	});

	test('handler returns Err: ActionFailed with cause', async () => {
		const actions = {
			fail_err: defineMutation({
				handler: () => Err(new Error('domain error')),
			}),
		};
		const inbound = JSON.stringify({
			type: 'dispatch_inbound',
			id: 'i10',
			from: 'R_laptop',
			action: 'fail_err',
			input: undefined,
		});

		const response = await runInboundDispatch({ rawFrame: inbound, actions });
		const parsed = JSON.parse(response!);
		expect(parsed.result.error.name).toBe('ActionFailed');
		expect(parsed.result.error.cause).toBe('domain error');
	});

	test('malformed frame: returns null (do not tear down the socket)', async () => {
		expect(
			await runInboundDispatch({ rawFrame: '{not json', actions: {} }),
		).toBeNull();
		expect(
			await runInboundDispatch({
				rawFrame: JSON.stringify({ type: 'not_dispatch' }),
				actions: {},
			}),
		).toBeNull();
	});

	test('handler returns Ok directly: preserved as-is', async () => {
		const actions = {
			already_ok: defineQuery({ handler: () => Ok({ shape: 'preserved' }) }),
		};
		const inbound = JSON.stringify({
			type: 'dispatch_inbound',
			id: 'i11',
			from: 'R_laptop',
			action: 'already_ok',
			input: undefined,
		});
		const response = await runInboundDispatch({ rawFrame: inbound, actions });
		const parsed = JSON.parse(response!);
		expect(parsed.result.data).toEqual({ shape: 'preserved' });
	});
});

// ════════════════════════════════════════════════════════════════════════════
// dispatch (caller-side HTTP wrapper)
// ════════════════════════════════════════════════════════════════════════════

describe('dispatch', () => {
	type FetchInit = RequestInit & { signal?: AbortSignal };
	type FakeFetch = (
		input: RequestInfo | URL,
		init?: FetchInit,
	) => Promise<Response>;

	let originalFetch: typeof globalThis.fetch;
	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function installFetch(fake: FakeFetch) {
		globalThis.fetch = fake as unknown as typeof globalThis.fetch;
	}

	test('happy path: decodes Ok body', async () => {
		let capturedBody = '';
		installFetch(async (_url, init) => {
			capturedBody = init?.body as string;
			return new Response(JSON.stringify(Ok({ closed: 2 })), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		});

		const result = await dispatch({
			dispatchUrl: 'https://api.example.com/rooms/wid/dispatch',
			installationId: 'R_laptop',
			req: { to: 'R_phone', action: 'tabs_close', input: { tabIds: [1, 2] } },
		});

		const data = expectOk(result) as { closed: number };
		expect(data.closed).toBe(2);
		const sent = JSON.parse(capturedBody);
		expect(sent).toEqual({
			from: 'R_laptop',
			to: 'R_phone',
			action: 'tabs_close',
			input: { tabIds: [1, 2] },
		});
	});

	test('RecipientOffline: decodes from Err body', async () => {
		installFetch(
			async () =>
				new Response(
					JSON.stringify(
						Err({
							name: 'RecipientOffline',
							to: 'R_phone',
							message: 'Recipient "R_phone" is offline',
						}),
					),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				),
		);

		const error = expectErr(
			await dispatch({
				dispatchUrl: 'https://api.example.com/rooms/wid/dispatch',
				installationId: 'R_laptop',
				req: { to: 'R_phone', action: 'tabs_close', input: {} },
			}),
		);

		expect(error.name).toBe('RecipientOffline');
	});

	test('ActionNotFound: decoded with action key', async () => {
		installFetch(
			async () =>
				new Response(
					JSON.stringify(
						Err({
							name: 'ActionNotFound',
							action: 'tabs_close',
							message: 'no handler',
						}),
					),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				),
		);

		const error = expectErr(
			await dispatch({
				dispatchUrl: 'https://api.example.com/rooms/wid/dispatch',
				installationId: 'R_laptop',
				req: { to: 'R_phone', action: 'tabs_close', input: {} },
			}),
		);

		expect(error.name).toBe('ActionNotFound');
		if (error.name !== 'ActionNotFound') throw new Error('unreachable');
		expect(error.action).toBe('tabs_close');
	});

	test('caller aborts: surfaces as Cancelled with the signal reason', async () => {
		installFetch(async (_url, init) => {
			const signal = init?.signal as AbortSignal | undefined;
			return new Promise<Response>((_resolve, reject) => {
				signal?.addEventListener('abort', () => {
					reject(new DOMException('aborted', 'AbortError'));
				});
			});
		});

		const controller = new AbortController();
		const pending = dispatch({
			dispatchUrl: 'https://api.example.com/rooms/wid/dispatch',
			installationId: 'R_laptop',
			req: {
				to: 'R_phone',
				action: 'tabs_close',
				input: {},
				signal: controller.signal,
			},
		});
		await Promise.resolve();
		controller.abort('user-cancel');
		const error = expectErr(await pending);

		expect(error.name).toBe('Cancelled');
		if (error.name !== 'Cancelled') throw new Error('unreachable');
		expect(error.reason).toBe('user-cancel');
	});

	test('network failure (fetch throws, no abort): NetworkFailed', async () => {
		installFetch(async () => {
			throw new TypeError('connect ECONNREFUSED');
		});

		const error = expectErr(
			await dispatch({
				dispatchUrl: 'https://api.example.com/rooms/wid/dispatch',
				installationId: 'R_laptop',
				req: { to: 'R_phone', action: 'tabs_close', input: {} },
			}),
		);

		expect(error.name).toBe('NetworkFailed');
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Error factory hygiene
// ════════════════════════════════════════════════════════════════════════════

describe('DispatchError variant factory', () => {
	test('RecipientOffline includes the target id in the message', () => {
		const { error } = DispatchError.RecipientOffline({ to: 'R_phone' });
		expect(error).toMatchObject({ name: 'RecipientOffline', to: 'R_phone' });
		expect(error?.message).toBe('Recipient "R_phone" is offline');
	});
	test('ActionFailed carries a string cause for safe JSON round-trip', () => {
		const { error } = DispatchError.ActionFailed({
			action: 'tabs_close',
			cause: 'boom',
		});
		expect(typeof error?.cause).toBe('string');
	});
});

// ════════════════════════════════════════════════════════════════════════════
// typedDispatch (typed overlay)
// ════════════════════════════════════════════════════════════════════════════

describe('typedDispatch', () => {
	test('delegates to the wrapped dispatch with the same arguments', async () => {
		let captured: unknown = null;
		const fakeDispatch = async (req: unknown) => {
			captured = req;
			return Ok({ closedCount: 2 });
		};
		const actions = {
			tabs_close: defineMutation({
				input: Type.Object({ tabIds: Type.Array(Type.Number()) }),
				handler: ({ tabIds }) => ({ closedCount: tabIds.length }),
			}),
		};
		type Actions = typeof actions;

		const tabManager = typedDispatch<Actions>(fakeDispatch);
		const result = await tabManager({
			to: 'R_phone',
			action: 'tabs_close',
			input: { tabIds: [1, 2] },
		});

		expect(captured).toEqual({
			to: 'R_phone',
			action: 'tabs_close',
			input: { tabIds: [1, 2] },
		});
		const data = expectOk(result);
		expect(data.closedCount).toBe(2);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Type-level tests for ActionInput / ActionOutput
// ════════════════════════════════════════════════════════════════════════════

// `bun test` runs these as runtime no-ops; they exist for the TypeScript
// compiler to enforce the type-level claims via assignability.

type Equals<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false;

const _typeTests = () => {
	const noInput = defineQuery({ handler: () => 'pong' });
	const withInput = defineMutation({
		input: Type.Object({ tabIds: Type.Array(Type.Number()) }),
		handler: ({ tabIds }) => ({ closedCount: tabIds.length }),
	});
	const asyncRaw = defineQuery({ handler: async () => 42 });
	const syncResult = defineMutation({
		handler: () => Ok('done') as Result<'done', { name: 'AppError' }>,
	});
	const asyncResult = defineQuery({
		handler: async () =>
			Ok({ a: 1 }) as Result<{ a: number }, { name: 'AppError' }>,
	});

	// ActionInput
	const _i1: Equals<ActionInput<typeof noInput>, { input?: never }> = true;
	const _i2: Equals<
		ActionInput<typeof withInput>,
		{ input: { tabIds: number[] } }
	> = true;

	// ActionOutput: peels Promise and Result down to T.
	const _o1: Equals<ActionOutput<typeof noInput>, string> = true;
	const _o2: Equals<
		ActionOutput<typeof withInput>,
		{ closedCount: number }
	> = true;
	const _o3: Equals<ActionOutput<typeof asyncRaw>, number> = true;
	const _o4: Equals<ActionOutput<typeof syncResult>, 'done'> = true;
	const _o5: Equals<ActionOutput<typeof asyncResult>, { a: number }> = true;

	// Call-site shape via the typed overlay.
	const dx = typedDispatch<{
		ping: typeof noInput;
		tabs_close: typeof withInput;
	}>(async () => Ok(undefined));

	// No-input action: `input` field is forbidden.
	void dx({ to: 'x', action: 'ping' });
	// @ts-expect-error -- `input` not allowed on no-input action.
	void dx({ to: 'x', action: 'ping', input: 'nope' });

	// With-input action: `input` field is required and typed.
	void dx({ to: 'x', action: 'tabs_close', input: { tabIds: [1, 2] } });
	// @ts-expect-error -- missing required input.
	void dx({ to: 'x', action: 'tabs_close' });

	// Discourage `_typeTests` from being flagged as unused; the function is
	// only evaluated by the TypeScript compiler.
	return { _i1, _i2, _o1, _o2, _o3, _o4, _o5 };
};
void _typeTests;
