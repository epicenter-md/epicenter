/**
 * Browser-side Tauri IPC mock for the Playwright e2e harness (layer A).
 *
 * Matter is hard-wired to Tauri: opening a vault calls a native dialog, and the grid talks to Rust
 * over `invoke` + a `Channel`. To drive the real Svelte UI in a plain browser, this stands an
 * in-memory vault behind `mockIPC`, faithful to the EXACT command contract the app uses:
 *
 *   plugin:store|load/get/set...                    -> open-vaults sidebar state
 *   watch_vault    { path, channel }            -> id;  channel sends string[]  (table folder paths)
 *   watch_folder   { path, channel }            -> id;  channel sends FileDelta[] (seed + echoes)
 *   read_entry     { path, fileName }           -> string | null
 *   write_entry    { path, fileName, content }  -> null;  echoes a Content delta + logs the write
 *   reset_mirror / write_mirror / drop_mirror_table -> null  (the SQLite mirror is a no-op here)
 *   query_mirror   { root, sql, limit }         -> { columns, rows }  (stems for ordering)
 *
 * This is a hand-copy of the Rust contract, so it only stays honest if the real commands do not
 * drift. The Rust `disk_edit_reprojects_through_scan_and_mirror` test and the matter-core
 * projector round-trip test are the real contract guards; this harness only proves the UI wiring
 * assuming the contract holds. Keep it thin: push logic into matter-core, not into this mock.
 *
 * Guarded behind `import.meta.env.VITE_E2E`, so it is dead code (tree-shaken) in the real build.
 */

import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';

/** The matter.json + card files of the fixture vault. The root IS the table (it carries the marker),
 *  so `watch_vault` reports the root itself as the one table (the marked-leaf rule). */
export const E2E_ROOT = '/virtual/vault';
const E2E_VAULT_ID = 'e2e-vault';
const STORE_KEY = 'vaults';

const FILES: Record<string, string> = {
	'matter.json': JSON.stringify({
		fields: {
			title: { type: 'string' },
			status: { type: 'string', enum: ['todo', 'done'] },
		},
		views: [
			{
				id: 'pipeline',
				title: 'Pipeline',
				type: 'board',
				groupBy: 'status',
				columns: ['todo', 'done'],
				card: ['title'],
			},
		],
	}),
	'card-a.md': '---\ntitle: Card A\nstatus: todo\n---\n# Card A\n',
	'card-b.md': '---\ntitle: Card B\nstatus: done\n---\n# Card B\n',
};

/** Every write the UI made, exposed for assertions: `page.evaluate(() => window.__E2E_WRITES__)`. */
declare global {
	interface Window {
		__E2E_WRITES__?: { fileName: string; content: string }[];
	}
}

type FileDelta =
	| { kind: 'content'; fileName: string; text: string }
	| { kind: 'removed'; fileName: string }
	| { kind: 'unreadable'; fileName: string };

type Channel<T> = { onmessage?: (message: T) => void };

/** The folder watcher's current contents as a seed batch (every relevant file as a Content delta). */
function seedDeltas(): FileDelta[] {
	return Object.entries(FILES).map(([fileName, text]) => ({
		kind: 'content',
		fileName,
		text,
	}));
}

/** The card stems (filenames minus `.md`, excluding the marker): what `query_mirror` returns for ordering. */
function stems(): string[] {
	return Object.keys(FILES)
		.filter((name) => name.endsWith('.md'))
		.map((name) => name.replace(/\.md$/, ''));
}

export function installMocks(): void {
	mockWindows('main');
	window.__E2E_WRITES__ = [];

	let nextId = 1;
	const storeRid = nextId++;
	const store: Record<string, unknown> = {
		[STORE_KEY]: [{ id: E2E_VAULT_ID, root: E2E_ROOT }],
	};
	// The live folder Channel, captured so a write can echo a Content delta back the way the real
	// watcher does (the app also applies its own write result; the echo mirrors production).
	let folderChannel: Channel<FileDelta[]> | undefined;

	// mockIPC passes the live args object (pre-serialization), so `args.channel` is the real Channel
	// the app constructed, with its `onmessage` already assigned before the invoke. Deliver on a
	// microtask so the invoke promise resolves first, exactly like a real async push.
	mockIPC((cmd, payload) => {
		const args = (payload ?? {}) as Record<string, unknown>;
		const push = <T>(channel: Channel<T>, message: T) =>
			queueMicrotask(() => channel.onmessage?.(message));

		switch (cmd) {
			case 'plugin:store|load':
				return storeRid;
			case 'plugin:store|get': {
				const key = args.key as string;
				return [store[key], key in store];
			}
			case 'plugin:store|set':
				store[args.key as string] = args.value;
				return undefined;
			case 'plugin:store|delete':
				delete store[args.key as string];
				return undefined;
			case 'plugin:store|clear':
			case 'plugin:store|reset':
				for (const key of Object.keys(store)) delete store[key];
				return undefined;
			case 'plugin:store|save':
				return undefined;

			// Opening is normally the native picker; the dialog module is aliased to a stub, and the
			// e2e test deep-links the vault, so this command is here only for completeness.
			case 'plugin:dialog|open':
				return E2E_ROOT;

			case 'watch_vault': {
				const channel = args.channel as Channel<string[]>;
				push(channel, [args.path as string]); // marked root => the root itself is the one table
				return nextId++;
			}
			case 'watch_folder': {
				folderChannel = args.channel as Channel<FileDelta[]>;
				push(folderChannel, seedDeltas());
				return nextId++;
			}
			case 'unwatch_vault':
			case 'unwatch_folder':
				return undefined;

			case 'read_entry':
				return FILES[args.fileName as string] ?? null;

			case 'write_entry': {
				const fileName = args.fileName as string;
				const content = args.content as string;
				FILES[fileName] = content;
				window.__E2E_WRITES__?.push({ fileName, content });
				// Echo the change the way the watcher would, so any view reading the folder stays current.
				if (folderChannel)
					push(folderChannel, [{ kind: 'content', fileName, text: content }]);
				return null;
			}

			// The SQLite mirror is Rust-only; here it is a no-op except query_mirror, which returns the
			// stems the grid uses to order rows when a filter/sort is active.
			case 'reset_mirror':
			case 'write_mirror':
			case 'drop_mirror_table':
				return null;
			case 'query_mirror':
				return { columns: ['stem'], rows: stems().map((s) => [s]) };

			default:
				throw new Error(`e2e mock: unhandled command ${cmd}`);
		}
	});
}
