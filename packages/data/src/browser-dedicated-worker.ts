import {
	type MessagePortLike,
	serveBrowserEpicenter,
} from './browser/worker.js';

type DedicatedWorkerScope = {
	postMessage(message: unknown): void;
	addEventListener(
		type: 'message',
		listener: (event: { data: unknown }) => void,
	): void;
	close(): void;
};

/**
 * Serve this worker's one page.
 *
 * A dedicated worker belongs to the page that constructed it, so its global
 * scope IS the port and there is nothing to connect: the page that owns this
 * worker is the only page it will ever have. Running at module scope is the
 * whole entry point; there is no second scope to serve, so there is nothing to
 * parameterize and nothing to export.
 */
const scope = globalThis as unknown as DedicatedWorkerScope;
serveBrowserEpicenter({
	postMessage: (message) => scope.postMessage(message),
	addEventListener: (type, listener) =>
		scope.addEventListener(type, listener as (event: { data: unknown }) => void),
	close: () => scope.close(),
} as MessagePortLike);
