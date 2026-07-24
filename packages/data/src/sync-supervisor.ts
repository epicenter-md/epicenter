import { extractErrorMessage } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Ok, type Result } from 'wellcrafted/result';

import type { PublishDocument } from './documents.js';
import type { Exchange, Replica, ReplicaError } from './replica/index.js';

const DEFAULT_EXCHANGE_INTERVAL_MS = 30_000;
const DEFAULT_DOCUMENT_COALESCE_MS = 250;
const BASE_RETRY_MS = 500;
const MAX_RETRY_MS = 30_000;

export type SyncState =
	| 'local'
	| 'syncing'
	| 'idle'
	| 'offline'
	| 'authentication-required';

export type SyncStatus = {
	state: SyncState;
	lastError: Error | undefined;
};

export type SyncCredentialProvider = {
	get(): string | undefined;
	subscribe?(listener: () => void): () => void;
};

export type SyncSupervisorSession = {
	exchange: Exchange;
	/**
	 * The session's outbound HTTP carrier for dirty document state. When
	 * absent the runtime keeps obligations durable and drains nothing; local
	 * document work waits for a session that can publish it.
	 */
	publishDocument?: PublishDocument;
	credentials?: SyncCredentialProvider;
};

export type SyncSchedule = (task: () => void, delayMs: number) => () => void;

export function createSyncSupervisor({
	replica,
	drainDocuments,
	exchangeIntervalMs = DEFAULT_EXCHANGE_INTERVAL_MS,
	documentCoalesceMs = DEFAULT_DOCUMENT_COALESCE_MS,
	schedule = scheduleTimeout,
	log = createLogger('data/sync'),
}: {
	replica: Replica;
	/**
	 * Publish owed document work for the attached session. Runs after the
	 * scalar exchange in a full cycle so liveness reflects freshly installed
	 * deletions, and alone in a coalesced document-only wake. Runs under the
	 * supervisor's one retry and status lifecycle; document publication never
	 * grows a second scheduler (ADR-0166).
	 */
	drainDocuments?: (
		session: SyncSupervisorSession,
	) => Promise<Result<void, ReplicaError>>;
	exchangeIntervalMs?: number;
	/** How long a document-only wake waits so rapid edits become one publish. */
	documentCoalesceMs?: number;
	schedule?: SyncSchedule;
	log?: Logger;
}) {
	const listeners = new Set<(status: SyncStatus) => void>();
	let status: SyncStatus = { state: 'local', lastError: undefined };
	let session: SyncSupervisorSession | undefined;
	let stopCredentials: (() => void) | undefined;
	let cancelScheduled: (() => void) | undefined;
	let cancelDocumentCoalesce: (() => void) | undefined;
	let running: Promise<Result<void, ReplicaError>> | undefined;
	let runningGeneration: number | undefined;
	let runRequested = false;
	let documentsRequested = false;
	let retryAttempt = 0;
	let generation = 0;
	let isDisposed = false;
	const stopOutbox = replica.subscribeOutbox(() => {
		void requestExchange();
	});

	function setStatus(next: SyncStatus): void {
		if (
			status.state === next.state &&
			status.lastError?.message === next.lastError?.message
		) {
			return;
		}
		status = next;
		for (const listener of listeners) {
			try {
				listener(status);
			} catch (cause) {
				log.error(new Error('Sync status subscriber threw', { cause }));
			}
		}
	}

	function hasCredentials(): boolean {
		return (
			session?.credentials?.get() !== undefined ||
			session?.credentials === undefined
		);
	}

	function cancelWake(): void {
		cancelScheduled?.();
		cancelScheduled = undefined;
	}

	function cancelDocumentWake(): void {
		cancelDocumentCoalesce?.();
		cancelDocumentCoalesce = undefined;
	}

	function scheduleWake(delayMs: number): void {
		cancelWake();
		cancelScheduled = schedule(() => {
			cancelScheduled = undefined;
			void requestExchange();
		}, delayMs);
	}

	function retryDelay(): number {
		const delay = Math.min(BASE_RETRY_MS * 2 ** retryAttempt, MAX_RETRY_MS);
		retryAttempt += 1;
		return delay;
	}

	async function drain(
		activeGeneration: number,
	): Promise<Result<void, ReplicaError>> {
		let lastResult: Result<void, ReplicaError> = Ok(undefined);
		while (
			(runRequested || documentsRequested) &&
			!isDisposed &&
			activeGeneration === generation &&
			session !== undefined
		) {
			// A full cycle exchanges scalars first so document publication sees
			// freshly installed deletions; a document-only wake skips the scalar
			// exchange it has no work for.
			const fullCycle = runRequested;
			runRequested = false;
			documentsRequested = false;
			if (!hasCredentials()) {
				setStatus({
					state: 'authentication-required',
					lastError: undefined,
				});
				return Ok(undefined);
			}
			setStatus({ state: 'syncing', lastError: status.lastError });
			const reportFailure = (failure: ReplicaError): void => {
				const error = new Error(extractErrorMessage(failure), {
					cause: failure,
				});
				setStatus({ state: 'offline', lastError: error });
				// Transport trouble retries with backoff; every other failure
				// still gets the periodic safety wake so recovery never depends
				// on another local write happening.
				if (failure.name === 'TransportFailed') {
					scheduleWake(retryDelay());
				} else {
					scheduleWake(exchangeIntervalMs);
				}
			};
			if (fullCycle) {
				lastResult = await replica.synchronize(session.exchange);
				if (activeGeneration !== generation || isDisposed) return lastResult;
				if (lastResult.error !== null) {
					reportFailure(lastResult.error);
					return lastResult;
				}
			}
			if (drainDocuments !== undefined) {
				lastResult = await drainDocuments(session);
				if (activeGeneration !== generation || isDisposed) return lastResult;
				if (lastResult.error !== null) {
					reportFailure(lastResult.error);
					return lastResult;
				}
			}
			retryAttempt = 0;
			setStatus({ state: 'idle', lastError: undefined });
		}
		if (!isDisposed && activeGeneration === generation && hasCredentials()) {
			scheduleWake(exchangeIntervalMs);
		}
		return lastResult;
	}

	function startDrain(): Promise<Result<void, ReplicaError>> {
		if (isDisposed || session === undefined)
			return Promise.resolve(Ok(undefined));
		if (running !== undefined) {
			return runningGeneration === generation
				? running
				: running.then(() => startDrain());
		}
		const activeGeneration = generation;
		runningGeneration = activeGeneration;
		running = drain(activeGeneration).finally(() => {
			running = undefined;
			runningGeneration = undefined;
			if (
				(runRequested || documentsRequested) &&
				!isDisposed &&
				activeGeneration === generation
			) {
				void startDrain();
			}
		});
		return running;
	}

	function requestExchange(): Promise<Result<void, ReplicaError>> {
		if (isDisposed || session === undefined)
			return Promise.resolve(Ok(undefined));
		cancelWake();
		runRequested = true;
		return startDrain();
	}

	/**
	 * Wake the document drain after a short coalescing delay so rapid local
	 * edits normally become one publication. The periodic full cycle remains
	 * the safety wake for crash, restart, and transient-failure recovery.
	 */
	function requestDocumentDrain(): void {
		if (isDisposed || session === undefined) return;
		if (cancelDocumentCoalesce !== undefined) return;
		cancelDocumentCoalesce = schedule(() => {
			cancelDocumentCoalesce = undefined;
			documentsRequested = true;
			void startDrain();
		}, documentCoalesceMs);
	}

	function credentialsChanged(): void {
		if (isDisposed || session === undefined) return;
		generation += 1;
		cancelWake();
		cancelDocumentWake();
		if (!hasCredentials()) {
			runRequested = false;
			setStatus({
				state: 'authentication-required',
				lastError: undefined,
			});
			return;
		}
		void requestExchange();
	}

	return {
		async attach(
			nextSession: SyncSupervisorSession,
		): Promise<Result<void, ReplicaError>> {
			if (isDisposed) throw new Error('Sync supervisor is disposed');
			generation += 1;
			cancelWake();
			cancelDocumentWake();
			stopCredentials?.();
			session = nextSession;
			stopCredentials =
				nextSession.credentials?.subscribe?.(credentialsChanged);
			if (!hasCredentials()) {
				setStatus({
					state: 'authentication-required',
					lastError: undefined,
				});
				return Ok(undefined);
			}
			return requestExchange();
		},
		requestExchange,
		requestDocumentDrain,
		get status(): SyncStatus {
			return status;
		},
		subscribe(listener: (next: SyncStatus) => void): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		dispose(): void {
			if (isDisposed) return;
			isDisposed = true;
			generation += 1;
			cancelWake();
			cancelDocumentWake();
			stopCredentials?.();
			stopCredentials = undefined;
			stopOutbox();
			session = undefined;
			listeners.clear();
		},
	};
}

function scheduleTimeout(task: () => void, delayMs: number): () => void {
	const timer = setTimeout(task, delayMs);
	return () => clearTimeout(timer);
}
