import { isOpenWebSocketDenial } from '@epicenter/sync';
import {
	DOCUMENT_BACKSTOP_CLOSE_CODE,
	DOCUMENT_BOUND,
	DOCUMENT_SUBPROTOCOL,
	type DocumentMeasure,
	decodeDocumentFrame,
	encodeDocumentFrame,
	exceedsDocumentBound,
	measureDocument,
} from '@epicenter/sync/document-v3';
import * as Y from '@y/y';

const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;
const BASE_RETRY_MS = 500;
const MAX_RETRY_MS = 30_000;
const protocolOrigin = Symbol('document-connection');

/**
 * Two-zone exact-measure scheduler constants.
 *
 * Send decisions consult the latest exact measure. Near the bound (either
 * dimension at or past half, or while suppressed) every observed update
 * triggers an exact recompute; far from the bound the recompute is debounced
 * to every 32nd observed update, with an immediate recompute for any single
 * update of 64 KiB or more. Far-zone staleness is therefore bounded by at
 * most 31 sub-64 KiB updates, and any race escape costs at most one authority
 * refusal (1009) per crossing because the reconnect path measures after
 * downstream before sending anything. A running byte/struct accumulator was
 * measured unsound (canonical growth reached 1.71x emitted update bytes and
 * deletion splits add structs no update reports), so no arithmetic shortcut
 * replaces the exact measure.
 */
const NEAR_ZONE_DIVISOR = 2;
const FAR_MEASURE_EVERY_UPDATES = 32;
const LARGE_UPDATE_BYTES = 65_536;

export type DocumentConnectionTerminalReason = 'auth' | 'upgrade';

export type DocumentConnectionVerdict =
	| { outcome: 'retry'; reason: 'network' }
	| {
			outcome: 'terminal';
			reason: DocumentConnectionTerminalReason;
	  };

export type DocumentConnectionStatus =
	| { phase: 'connecting'; attempt: number }
	| {
			phase: 'pending';
			reason: 'network';
			retryInMs: number;
	  }
	| { phase: 'connected' }
	| {
			/**
			 * Connected and receiving remote changes, but past the document bound,
			 * so local changes stay durable and are not sent. `recoverable` is true
			 * for byte fullness, which exits on its own once deletions shrink the
			 * document; structural fullness does not exit by deletion, and its only
			 * recovery is moving content to a fresh row document.
			 */
			phase: 'document-full';
			recoverable: boolean;
	  }
	| {
			phase: 'terminal';
			reason: DocumentConnectionTerminalReason;
	  }
	| { phase: 'disposed' };

export type DocumentSocketAdmission =
	| { outcome: 'opened'; socket: WebSocket }
	| DocumentConnectionVerdict;

export type DocumentConnectionOptions = {
	/** URL whose authenticated route identifies exactly one row document. */
	url: string | URL;
	/**
	 * Auth-owned upgrade capability. It appends the bearer subprotocol without
	 * exposing credentials here and converts HTTP upgrade refusals into a
	 * lifecycle verdict.
	 */
	openSocket(
		url: string | URL,
		protocols: string[],
	): Promise<DocumentSocketAdmission> | DocumentSocketAdmission;
	/** Convert transport close metadata into the shared lifecycle verdict. */
	classifyClose(event: {
		code: number;
		reason: string;
		wasClean: boolean;
	}): DocumentConnectionVerdict;
	/** Injectable one-shot scheduler. The returned function cancels the task. */
	schedule?: (task: () => void, delayMs: number) => () => void;
	/** Injectable uniform random source for retry jitter. */
	random?: () => number;
};

export type OpenAuthenticatedWebSocket = (
	url: string | URL,
	protocols?: string[],
) => Promise<WebSocket>;

/** Build the route whose path owns one document address and protocol scope. */
export function rowDocumentWebSocketUrl({
	baseUrl,
	workspaceId,
	address,
}: {
	baseUrl: string;
	workspaceId: string;
	address: { table: string; rowId: string };
}): URL {
	const url = new URL(baseUrl);
	url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
	url.pathname = `/api/workspaces/${encodeURIComponent(workspaceId)}/tables/${encodeURIComponent(address.table)}/rows/${encodeURIComponent(address.rowId)}/document`;
	url.search = '';
	url.hash = '';
	return url;
}

/** Adapt the auth-owned opener and shared close codes once for all runtimes. */
export function attachAuthenticatedDocumentConnection({
	document,
	url,
	openWebSocket,
}: {
	document: Y.Doc;
	url: string | URL;
	openWebSocket: OpenAuthenticatedWebSocket;
}) {
	return attachDocumentConnection(document, {
		url,
		async openSocket(socketUrl, protocols) {
			try {
				return {
					outcome: 'opened',
					socket: await openWebSocket(socketUrl, protocols),
				};
			} catch (cause) {
				if (isOpenWebSocketDenial(cause)) {
					return cause.permanence === 'permanent'
						? { outcome: 'terminal', reason: 'auth' }
						: { outcome: 'retry', reason: 'network' };
				}
				return { outcome: 'retry', reason: 'network' };
			}
		},
		classifyClose({ code }) {
			// 1009 is the authority's defensive backstop against a stale estimate.
			// It is retryable: the reconnect applies downstream state, measures
			// exactly, and suppresses, so one crossing costs at most one refusal.
			if (code === DOCUMENT_BACKSTOP_CLOSE_CODE) {
				return { outcome: 'retry', reason: 'network' };
			}
			if (code === 1002) return { outcome: 'terminal', reason: 'upgrade' };
			return { outcome: 'retry', reason: 'network' };
		},
	});
}

/**
 * Attach one route-bound Yjs 14 connection to one document.
 *
 * Auth, protocol-major, network, and liveness decisions arrive from HTTP
 * upgrade or WebSocket close classification. Binary frames carry Yjs data
 * only. The connection is an advisory estimator, never an enforcer: it
 * suppresses every upstream update-bearing frame while the document measures
 * past the shared bound, keeps applying downstream, and resumes on its own
 * when a measure comes back under.
 */
export function attachDocumentConnection(
	doc: Y.Doc,
	options: DocumentConnectionOptions,
) {
	const listeners = new Set<(status: DocumentConnectionStatus) => void>();
	const schedule = options.schedule ?? scheduleTimeout;
	const random = options.random ?? Math.random;
	let status: DocumentConnectionStatus = { phase: 'connecting', attempt: 0 };
	let socket: WebSocket | undefined;
	let cancelRetry: (() => void) | undefined;
	let attempt = 0;
	let cycle = 0;
	let disposed = false;
	let connectedOnce = false;
	const connected = Promise.withResolvers<void>();
	const disposedBarrier = Promise.withResolvers<void>();

	// Estimator state. The measure survives reconnects; the handshake facts
	// are per socket cycle and reset in bind().
	let lastMeasure: DocumentMeasure | undefined;
	let updatesSinceMeasure = 0;
	let handshakeComplete = false;
	let serverStateVector: Uint8Array | undefined;
	let owedServerReply = false;

	function setStatus(next: DocumentConnectionStatus): void {
		status = next;
		for (const listener of listeners) listener(next);
	}

	function isSuppressed(): boolean {
		return lastMeasure !== undefined && exceedsDocumentBound(lastMeasure);
	}

	function isNearZone(): boolean {
		if (!lastMeasure) return false;
		return (
			isSuppressed() ||
			lastMeasure.stateBytes >= DOCUMENT_BOUND.stateBytes / NEAR_ZONE_DIVISOR ||
			lastMeasure.stateStructs >=
				DOCUMENT_BOUND.stateStructs / NEAR_ZONE_DIVISOR
		);
	}

	function connectedStatus(): DocumentConnectionStatus {
		return isSuppressed()
			? {
					phase: 'document-full',
					recoverable:
						(lastMeasure?.stateStructs ?? 0) <= DOCUMENT_BOUND.stateStructs,
				}
			: { phase: 'connected' };
	}

	function send(frame: Parameters<typeof encodeDocumentFrame>[0]): void {
		if (socket?.readyState !== SOCKET_OPEN) return;
		const encoded = encodeDocumentFrame(frame);
		const copy = new Uint8Array(encoded.byteLength);
		copy.set(encoded);
		socket.send(copy);
	}

	function sendDeferredReply(): void {
		if (!handshakeComplete || !serverStateVector) return;
		if (socket?.readyState !== SOCKET_OPEN) return;
		send({
			kind: 'sync-response',
			update: Y.encodeStateAsUpdateV2(doc, serverStateVector),
		});
		owedServerReply = false;
	}

	function measureNow(): void {
		const wasSuppressed = isSuppressed();
		lastMeasure = measureDocument(doc);
		updatesSinceMeasure = 0;
		const suppressed = isSuppressed();
		if (!handshakeComplete) return;
		// Recovery sends one diff against the last known server state vector. A
		// stale vector over-sends idempotent structs, never loses data, and stays
		// within the frame envelope because the diff is bounded by this
		// document's own canonical state.
		if (!suppressed && (wasSuppressed || owedServerReply)) {
			sendDeferredReply();
		}
		if (status.phase === 'connected' || status.phase === 'document-full') {
			const next = connectedStatus();
			const changed =
				next.phase !== status.phase ||
				(next.phase === 'document-full' &&
					status.phase === 'document-full' &&
					next.recoverable !== status.recoverable);
			if (changed) setStatus(next);
		}
	}

	function handleDocUpdate(update: Uint8Array, origin: unknown): void {
		const isLocal = origin !== protocolOrigin;
		updatesSinceMeasure += 1;
		if (
			update.byteLength >= LARGE_UPDATE_BYTES ||
			isNearZone() ||
			updatesSinceMeasure >= FAR_MEASURE_EVERY_UPDATES
		) {
			measureNow();
		}
		if (isLocal && handshakeComplete && !isSuppressed()) {
			send({ kind: 'update', update });
		}
	}

	function retry(
		verdict: Extract<DocumentConnectionVerdict, { outcome: 'retry' }>,
	) {
		if (disposed) return;
		const retryInMs = retryDelay(attempt, random());
		attempt += 1;
		setStatus({
			phase: 'pending',
			reason: verdict.reason,
			retryInMs,
		});
		cancelRetry?.();
		cancelRetry = schedule(() => {
			cancelRetry = undefined;
			void connect();
		}, retryInMs);
	}

	function terminal(
		verdict: Extract<DocumentConnectionVerdict, { outcome: 'terminal' }>,
	): void {
		if (disposed) return;
		cancelRetry?.();
		cancelRetry = undefined;
		setStatus({
			phase: 'terminal',
			reason: verdict.reason,
		});
		if (!connectedOnce) {
			connected.reject(
				new Error(`Document connection stopped: ${verdict.reason}`),
			);
		}
	}

	function handleVerdict(verdict: DocumentConnectionVerdict): void {
		if (verdict.outcome === 'terminal') terminal(verdict);
		else retry(verdict);
	}

	function bind(opened: WebSocket, activeCycle: number): void {
		if (disposed || activeCycle !== cycle) {
			closeSocket(opened);
			return;
		}
		socket = opened;
		opened.binaryType = 'arraybuffer';
		handshakeComplete = false;
		serverStateVector = undefined;
		owedServerReply = false;

		const handleOpen = () => {
			if (opened.protocol !== DOCUMENT_SUBPROTOCOL) {
				opened.close(1002, 'document subprotocol mismatch');
				return;
			}
			send({ kind: 'sync-request', stateVector: Y.encodeStateVector(doc) });
		};

		opened.onopen = handleOpen;
		opened.onmessage = (event) => {
			if (disposed || socket !== opened) return;
			try {
				const frame = decodeDocumentFrame(messageBytes(event.data));
				switch (frame.kind) {
					case 'sync-request':
						// Defer the reply: upstream stays suppressed until downstream
						// state is applied and an exact measure is taken, because a
						// pre-downstream estimate under-reads the merged document.
						serverStateVector = frame.stateVector;
						owedServerReply = true;
						if (handshakeComplete) measureNow();
						return;
					case 'sync-response':
						Y.applyUpdateV2(doc, frame.update, protocolOrigin);
						if (handshakeComplete) return;
						handshakeComplete = true;
						attempt = 0;
						measureNow();
						setStatus(connectedStatus());
						if (!connectedOnce) {
							connectedOnce = true;
							connected.resolve();
						}
						return;
					case 'update':
						Y.applyUpdateV2(doc, frame.update, protocolOrigin);
						return;
				}
			} catch {
				opened.close(1002, 'invalid document frame');
			}
		};
		opened.onerror = () => {
			// Browsers follow WebSocket errors with a close event. That event owns
			// the lifecycle classification and retry decision.
		};
		opened.onclose = (event) => {
			if (socket !== opened) return;
			socket = undefined;
			if (disposed || activeCycle !== cycle) return;
			handleVerdict(
				options.classifyClose({
					code: event.code,
					reason: event.reason,
					wasClean: event.wasClean,
				}),
			);
		};

		if (opened.readyState === SOCKET_OPEN) handleOpen();
	}

	async function connect(): Promise<void> {
		if (disposed || status.phase === 'terminal') return;
		const activeCycle = ++cycle;
		setStatus({ phase: 'connecting', attempt });
		let admission: DocumentSocketAdmission;
		try {
			admission = await options.openSocket(options.url, [DOCUMENT_SUBPROTOCOL]);
		} catch {
			admission = { outcome: 'retry', reason: 'network' };
		}
		if (disposed || activeCycle !== cycle) {
			if (admission.outcome === 'opened') closeSocket(admission.socket);
			return;
		}
		if (admission.outcome === 'opened') bind(admission.socket, activeCycle);
		else handleVerdict(admission);
	}

	function dispose(): void {
		if (disposed) return;
		disposed = true;
		cycle += 1;
		cancelRetry?.();
		cancelRetry = undefined;
		doc.off('updateV2', handleDocUpdate);
		const opened = socket;
		socket = undefined;
		if (opened) {
			opened.onopen = null;
			opened.onmessage = null;
			opened.onerror = null;
			opened.onclose = null;
			closeSocket(opened);
		}
		setStatus({ phase: 'disposed' });
		listeners.clear();
		if (!connectedOnce) {
			connected.reject(
				new Error('Document destroyed before its first connection'),
			);
		}
		disposedBarrier.resolve();
	}

	doc.on('updateV2', handleDocUpdate);
	void connect();

	return {
		/** Resolves after the first state-vector exchange installs an update. */
		whenConnected: connected.promise,
		/** Resolves after explicit connection disposal completes. */
		whenDisposed: disposedBarrier.promise,
		/** Stop reconnects and close the current socket. */
		dispose,
		/** Current document-local connection state. */
		get status() {
			return status;
		},
		/** Subscribe to future status changes. */
		onStatusChange(listener: (next: DocumentConnectionStatus) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

function retryDelay(attempt: number, random: number): number {
	const capped = Math.min(BASE_RETRY_MS * 2 ** attempt, MAX_RETRY_MS);
	const boundedRandom = Math.max(0, Math.min(1, random));
	return Math.round(capped * (0.5 + boundedRandom / 2));
}

function scheduleTimeout(task: () => void, delayMs: number): () => void {
	const timer = setTimeout(task, delayMs);
	return () => clearTimeout(timer);
}

function messageBytes(data: unknown): Uint8Array {
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) {
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	}
	throw new TypeError('Document connection accepts binary frames only');
}

function closeSocket(socket: WebSocket): void {
	if (socket.readyState === SOCKET_CLOSED) return;
	socket.close();
}

export type DocumentConnection = ReturnType<typeof attachDocumentConnection>;
