import { extractErrorMessage } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Ok, type Result } from 'wellcrafted/result';

import type { PublishDocument } from './documents.js';
import { type Exchange, type Replica, ReplicaError } from './replica/index.js';

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

	/**
	 * Call an injected dependency without letting it escape.
	 *
	 * The supervisor calls out to code it does not own on nearly every path: the
	 * scheduler and its canceller, the credential provider, the unsubscribes, and
	 * the logger. Any of them can throw, and most are reached from a background
	 * wake or a teardown step where a throw has no owner: it would surface as an
	 * unrelated caller's failure, or strand the rest of a teardown and leave a
	 * half-disposed supervisor still waking a dead session.
	 *
	 * One rule instead of a habit at each call site: crossing out of the
	 * supervisor is contained, and the failure is logged rather than propagated.
	 */
	function contain(what: string, step: () => void): void {
		try {
			step();
		} catch (cause) {
			try {
				log.error(new Error(`Sync supervisor could not ${what}`, { cause }));
			} catch {
				// The logger is itself injected. If reporting fails there is nowhere
				// left to report it, and it must not become the caller's problem.
			}
		}
	}

	function cancelWake(): void {
		const cancel = cancelScheduled;
		cancelScheduled = undefined;
		if (cancel !== undefined) contain('cancel the scheduled wake', cancel);
	}

	function cancelDocumentWake(): void {
		const cancel = cancelDocumentCoalesce;
		cancelDocumentCoalesce = undefined;
		if (cancel !== undefined) contain('cancel the document wake', cancel);
	}

	function scheduleWake(delayMs: number): void {
		cancelWake();
		// A scheduler that throws leaves this cycle with no wake rather than
		// turning a completed cycle into a reported failure.
		contain('schedule the next wake', () => {
			cancelScheduled = schedule(() => {
				cancelScheduled = undefined;
				void requestExchange();
			}, delayMs);
		});
	}

	function retryDelay(): number {
		const delay = Math.min(BASE_RETRY_MS * 2 ** retryAttempt, MAX_RETRY_MS);
		retryAttempt += 1;
		return delay;
	}

	/**
	 * Update status and retry policy for one failed cycle. The single owner of
	 * that transition, so a cycle reports its failure exactly once whether the
	 * failure arrived as a typed Result or as an unexpected throw.
	 */
	function reportFailure(failure: ReplicaError): void {
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

	/**
	 * Run one drain to completion without ever rejecting.
	 *
	 * This is the supervisor's single failure boundary. Expected synchronization
	 * trouble already arrives as a typed Result; only a bug or a throwing
	 * injected dependency reaches the catch. Either way the caller receives a
	 * Result, which is what lets background wakes discard this promise safely
	 * and lets a generation continuation chain off it without being dropped.
	 */
	async function runDrain(
		activeGeneration: number,
	): Promise<Result<void, ReplicaError>> {
		try {
			return await drain(activeGeneration);
		} catch (cause) {
			const faulted = ReplicaError.SyncFaulted({ cause });
			// A retired or disposed cycle reports nothing and schedules nothing,
			// matching the guards the Result path applies before `reportFailure`.
			// Without this, disposal would end holding a live retry timer and a
			// superseded generation could clobber the current status.
			if (activeGeneration === generation && !isDisposed) {
				// Reported once, here, because no call site owns this promise.
				contain('report a failed sync cycle', () => {
					log.error(faulted.error);
					reportFailure(faulted.error);
				});
			}
			return faulted;
		}
	}

	function startDrain(): Promise<Result<void, ReplicaError>> {
		if (isDisposed || session === undefined)
			return Promise.resolve(Ok(undefined));
		if (running !== undefined) {
			return runningGeneration === generation
				? running
				: // Safe because `running` cannot reject: a rejected continuation
					// here would drop the queued generation change entirely.
					running.then(() => startDrain());
		}
		const activeGeneration = generation;
		runningGeneration = activeGeneration;
		running = runDrain(activeGeneration).finally(() => {
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

	/**
	 * Contained end to end because this runs as the credential provider's own
	 * subscriber: a throw here (most likely from `get`) would otherwise land in
	 * whatever rotated the token, blaming an auth refresh for a sync fault.
	 */
	function credentialsChanged(): void {
		contain('handle a credential change', () => {
			if (isDisposed || session === undefined) return;
			generation += 1;
			cancelWake();
			cancelDocumentWake();
			if (!hasCredentials()) {
				runRequested = false;
				documentsRequested = false;
				setStatus({
					state: 'authentication-required',
					lastError: undefined,
				});
				return;
			}
			void requestExchange();
		});
	}

	return {
		async attach(
			nextSession: SyncSupervisorSession,
		): Promise<Result<void, ReplicaError>> {
			if (isDisposed) throw new Error('Sync supervisor is disposed');
			generation += 1;
			cancelWake();
			cancelDocumentWake();
			const stopPreviousCredentials = stopCredentials;
			stopCredentials = undefined;
			if (stopPreviousCredentials !== undefined) {
				// Contained like disposal's: a throwing unsubscribe must not leave
				// this half-attached, with the generation bumped and the old
				// subscription still live.
				contain(
					'stop the previous credential subscription',
					stopPreviousCredentials,
				);
			}
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
			const stopNextCredentials = stopCredentials;
			stopCredentials = undefined;
			if (stopNextCredentials !== undefined) {
				contain('stop the credential subscription', stopNextCredentials);
			}
			contain('stop the outbox subscription', stopOutbox);
			session = undefined;
			listeners.clear();
		},
	};
}

function scheduleTimeout(task: () => void, delayMs: number): () => void {
	const timer = setTimeout(task, delayMs);
	return () => clearTimeout(timer);
}
