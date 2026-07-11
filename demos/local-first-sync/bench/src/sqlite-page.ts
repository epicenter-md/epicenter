/**
 * Engine C page adapter: proxies the bench API to the SQLite OPFS worker.
 * Memory is measured page-side with measureUserAgentSpecificMemory, which
 * includes dedicated workers when cross-origin isolated.
 */

import { measureMemory } from './shape';
import SqliteWorker from './sqlite-worker?worker';

const worker = new SqliteWorker();

let nextId = 1;
const pending = new Map<
	number,
	{ resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

const ready = new Promise<void>((resolve) => {
	const onReady = (event: MessageEvent) => {
		if ((event.data as { ready?: boolean }).ready) {
			worker.removeEventListener('message', onReady);
			resolve();
		}
	};
	worker.addEventListener('message', onReady);
});

worker.addEventListener('message', (event: MessageEvent) => {
	const { id, result, error } = event.data as {
		id?: number;
		result?: unknown;
		error?: string;
	};
	if (id === undefined) return;
	const entry = pending.get(id);
	if (!entry) return;
	pending.delete(id);
	if (error !== undefined) entry.reject(new Error(error));
	else entry.resolve(result);
});

function call<T>(method: string, ...args: unknown[]): Promise<T> {
	const id = nextId++;
	return new Promise<T>((resolve, reject) => {
		pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
		worker.postMessage({ id, method, args });
	});
}

window.bench = {
	engine: 'sqlite-opfs',
	reset: () => call('reset'),
	seed: (n) => call('seed', n),
	hydrate: () => call('hydrate'),
	query100: () => call('query100'),
	search: (needle) => call('search', needle),
	editOne: (index) => call('editOne', index),
	churn: (opCount) => call('churn', opCount),
	remoteApply: (editCount) => call('remoteApply', editCount),
	persistSize: () => call('persistSize'),
	async memory() {
		// Page heap + worker heap: the WASM/page-cache cost lives in the worker.
		const page = await measureMemory();
		if (page.source === 'measureUserAgentSpecificMemory') return page;
		const worker = await call<{ bytes: number; source: string }>('memory');
		if (worker.bytes < 0) return page;
		return {
			bytes: page.bytes + worker.bytes,
			source: `${page.source} + ${worker.source}`,
		};
	},
};

window.benchReady = ready.then(async () => {
	if (new URLSearchParams(location.search).has('noclock')) {
		await call('configure', { clock: false });
	}
});

import { maybeAutorun } from './autorun';
void window.benchReady.then(maybeAutorun);
