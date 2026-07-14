/**
 * Sync engine: outbox push, cursor pull, WS poke subscription.
 *
 * Sync is an optional enhancement bolted onto an already-complete local
 * database. Failure modes are explicit states, never blockers:
 *  - 'off'              signed out or network toggled off; local-only
 *  - 'live'             connected, poke-driven
 *  - 'error'            unreachable server; retry with backoff, local fine
 *  - 'schema-mismatch'  server speaks a newer schema major; sync PAUSED,
 *                       local reads/writes continue untouched
 */

import {
	type Poke,
	PROTOCOL_VERSION,
	type PullResponse,
	type PushResponse,
} from '../../shared/protocol';
import type { DbClient } from './db-client';

export type SyncStatus = 'off' | 'live' | 'error' | 'schema-mismatch';

export function createSync(opts: {
	db: DbClient;
	serverUrl: string;
	token: string;
	clientId: string;
	schemaMajor: number;
	/** Demo network kill-switch: when false, every request throws. */
	isOnline: () => boolean;
	onStatus: (status: SyncStatus) => void;
}) {
	let status: SyncStatus = 'off';
	let ws: WebSocket | null = null;
	let stopped = false;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let syncing = Promise.resolve();

	function setStatus(next: SyncStatus) {
		if (status !== next) {
			status = next;
			opts.onStatus(next);
		}
	}

	async function request(path: string, init?: RequestInit): Promise<Response> {
		if (!opts.isOnline()) throw new Error('offline (demo toggle)');
		return fetch(`${opts.serverUrl}${path}`, {
			...init,
			headers: {
				authorization: `Bearer ${opts.token}`,
				'content-type': 'application/json',
				...init?.headers,
			},
		});
	}

	async function push(): Promise<void> {
		const outbox = await opts.db.outbox();
		if (outbox.length === 0) return;
		const response = await request('/sync/push', {
			method: 'POST',
			body: JSON.stringify({
				protocolVersion: PROTOCOL_VERSION,
				schemaMajor: opts.schemaMajor,
				clientId: opts.clientId,
				ops: outbox.map((entry) => entry.op),
			}),
		});
		const body = (await response.json()) as PushResponse;
		if (!body.ok) {
			if (body.reason === 'schema-mismatch') {
				setStatus('schema-mismatch');
				throw new Error('schema-mismatch');
			}
			throw new Error('push failed');
		}
		await opts.db.clearOutbox(outbox[outbox.length - 1].idx);
	}

	async function pull(): Promise<void> {
		const { cursor } = await opts.db.cursor();
		const response = await request(
			`/sync/pull?cursor=${cursor}&schemaMajor=${opts.schemaMajor}`,
		);
		const body = (await response.json()) as PullResponse;
		if (!body.ok) {
			if (body.reason === 'schema-mismatch') {
				setStatus('schema-mismatch');
				throw new Error('schema-mismatch');
			}
			throw new Error('pull failed');
		}
		if (body.ops.length > 0 || body.cursor !== cursor) {
			await opts.db.applyRemote({ ops: body.ops, cursor: body.cursor });
		}
	}

	/** One full cycle, serialized so pokes can't interleave mid-push. */
	function syncNow(): Promise<void> {
		syncing = syncing.then(async () => {
			if (stopped) return;
			try {
				await push();
				await pull();
				setStatus('live');
			} catch (error) {
				if (status !== 'schema-mismatch') {
					setStatus('error');
					scheduleRetry();
				}
				console.warn('[sync]', error);
			}
		});
		return syncing;
	}

	function scheduleRetry() {
		if (retryTimer || stopped) return;
		retryTimer = setTimeout(() => {
			retryTimer = null;
			connect();
		}, 2000);
	}

	function connect() {
		if (stopped || !opts.isOnline()) return;
		if (status === 'schema-mismatch') return;
		const wsUrl = `${opts.serverUrl.replace(/^http/, 'ws')}/sync/ws?token=${opts.token}`;
		ws?.close();
		ws = new WebSocket(wsUrl);
		ws.onopen = () => {
			void syncNow();
		};
		ws.onmessage = (event) => {
			const poke = JSON.parse(String(event.data)) as Poke;
			if (poke.type === 'poke') void syncNow();
		};
		ws.onclose = () => {
			if (!stopped && status !== 'schema-mismatch') {
				setStatus('error');
				scheduleRetry();
			}
		};
		ws.onerror = () => {
			ws?.close();
		};
	}

	return {
		start() {
			stopped = false;
			connect();
		},
		stop() {
			stopped = true;
			ws?.close();
			ws = null;
			if (retryTimer) clearTimeout(retryTimer);
			retryTimer = null;
			setStatus('off');
		},
		syncNow,
		get status() {
			return status;
		},
	};
}

export type Sync = ReturnType<typeof createSync>;
