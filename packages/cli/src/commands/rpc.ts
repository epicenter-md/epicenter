/**
 * `epicenter rpc <action> [--args]` — invoke an action on a remote peer via RPC.
 *
 * Connects to the sync server, discovers peers via awareness, sends a typed
 * RPC call to the target peer, and prints the result.
 *
 * @example
 * ```bash
 * epicenter rpc tabs.list -w epicenter.tab-manager
 * epicenter rpc tabs.open --url "https://example.com" -w epicenter.tab-manager
 * epicenter rpc tabs.close --tabIds '[1,2,3]' -w epicenter.tab-manager
 * epicenter rpc tabs.list --peer 42 -w epicenter.tab-manager
 * ```
 */

import type { Argv } from 'yargs';
import { loadConfig } from '../load-config';
import {
	defineCommand,
	resolveWorkspace,
	withWorkspaceOptions,
} from '../util/command';
import { output, outputError } from '../util/format-output';

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

/**
 * Wait for the sync extension to reach 'connected' status.
 *
 * Returns `true` if connected within the timeout, `false` otherwise.
 */
function waitForSync(
	sync: {
		readonly status: { phase: string };
		onStatusChange: (cb: (s: { phase: string }) => void) => () => void;
	},
	timeoutMs: number,
): Promise<boolean> {
	if (sync.status.phase === 'connected') return Promise.resolve(true);

	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			unsub();
			resolve(false);
		}, timeoutMs);

		const unsub = sync.onStatusChange((status) => {
			if (status.phase === 'connected') {
				clearTimeout(timer);
				unsub();
				resolve(true);
			}
		});
	});
}

/**
 * Wait for at least one remote peer to appear in awareness.
 *
 * If `targetPeer` is specified, waits for that specific clientId.
 * Otherwise resolves with the first remote peer discovered.
 */
function waitForPeer(
	awareness: {
		peers: () => Map<number, Record<string, unknown>>;
		observe: (cb: (changes: Map<number, string>) => void) => () => void;
	},
	targetPeer: number | undefined,
	timeoutMs: number,
): Promise<number | null> {
	const check = (): number | null => {
		const peers = awareness.peers();
		if (targetPeer !== undefined)
			return peers.has(targetPeer) ? targetPeer : null;
		const first = peers.keys().next();
		return first.done ? null : first.value;
	};

	const found = check();
	if (found !== null) return Promise.resolve(found);

	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			unsub();
			resolve(null);
		}, timeoutMs);

		const unsub = awareness.observe(() => {
			const found = check();
			if (found !== null) {
				clearTimeout(timer);
				unsub();
				resolve(found);
			}
		});
	});
}

/**
 * Parse a CLI argument value, handling JSON arrays/objects and plain strings.
 */
function parseArgValue(value: string): unknown {
	const trimmed = value.trim();
	if (
		(trimmed.startsWith('[') && trimmed.endsWith(']')) ||
		(trimmed.startsWith('{') && trimmed.endsWith('}'))
	) {
		try {
			return JSON.parse(trimmed);
		} catch {
			return value;
		}
	}
	return value;
}

export const rpcCommand = defineCommand({
	command: 'rpc [action]',
	describe: 'Invoke an action on a remote peer via RPC',
	builder: (y: Argv) =>
		withWorkspaceOptions(y)
			.positional('action', {
				type: 'string',
				describe: 'Action path in dot notation (e.g. tabs.list)',
			})
			.option('peer', {
				type: 'number',
				describe: 'Target peer clientId (default: first discovered peer)',
			})
			.option('timeout', {
				type: 'number',
				default: 5000,
				describe: 'RPC timeout in milliseconds',
			})
			.option('peers', {
				type: 'boolean',
				default: false,
				describe: 'List connected peers and exit',
			})
			.strict(false),
	handler: async (argv: any) => {
		let clients: any[] | undefined;
		try {
			const loaded = await loadConfig(argv.dir ?? '.');
			clients = loaded.clients;
			const client = resolveWorkspace(clients, argv.workspace);
			await client.whenReady;

			const sync = (client.extensions as Record<string, any>)?.sync;
			if (!sync?.rpc) {
				throw new Error(
					'This workspace has no sync extension. RPC requires a sync extension with a server connection.',
				);
			}

			const connected = await waitForSync(sync, DEFAULT_CONNECT_TIMEOUT_MS);
			if (!connected) {
				throw new Error(
					`Sync did not connect within ${DEFAULT_CONNECT_TIMEOUT_MS / 1000}s. Is the server running?`,
				);
			}

			if (argv.peers) {
				const peers = client.awareness.peers();
				const entries: Record<string, unknown>[] = [];
				for (const [clientId, state] of peers) {
					entries.push({ clientId, ...state });
				}
				output(entries, { format: argv.format });
				return;
			}

			if (!argv.action) {
				throw new Error(
					'Missing required argument: action (e.g. epicenter rpc tabs.list)',
				);
			}

			const targetPeer = await waitForPeer(
				client.awareness,
				argv.peer,
				DEFAULT_CONNECT_TIMEOUT_MS,
			);
			if (targetPeer === null) {
				const peers = client.awareness.peers();
				if (peers.size === 0) {
					throw new Error(
						'No remote peers found. Is the target app running and connected to the sync server?',
					);
				}
				throw new Error(
					`Peer ${argv.peer} not found. Connected peers: ${[...peers.keys()].join(', ')}`,
				);
			}

			const skipKeys = new Set([
				'_',
				'$0',
				'action',
				'dir',
				'C',
				'workspace',
				'w',
				'format',
				'peer',
				'timeout',
				'peers',
			]);
			let input: Record<string, unknown> | undefined;
			for (const [key, value] of Object.entries(argv)) {
				if (skipKeys.has(key) || key.includes('-')) continue;
				if (value === undefined) continue;
				input ??= {};
				input[key] = typeof value === 'string' ? parseArgValue(value) : value;
			}

			const { data, error } = await sync.rpc(targetPeer, argv.action, input, {
				timeout: argv.timeout,
			});

			if (error) {
				outputError(`RPC error: ${JSON.stringify(error)}`);
				process.exitCode = 1;
			} else {
				output(data, { format: argv.format });
			}
		} catch (err) {
			outputError(err instanceof Error ? err.message : String(err));
			process.exitCode = 1;
		} finally {
			if (clients) await Promise.all(clients.map((c: any) => c.dispose()));
		}
	},
});
