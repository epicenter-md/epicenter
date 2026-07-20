import {
	type DocumentAddress,
	type RowDocument,
	rowDocumentConnectionTarget,
	type SyncCredentialProvider,
} from '@epicenter/data';

import {
	BEARER_SUBPROTOCOL_PREFIX,
	DOCUMENT_SUBPROTOCOL,
	type DocumentPeer,
	decodeDocumentFrame,
	documentWebSocketUrl,
	encodeDocumentFrame,
	exceedsDocumentBound,
	measureDocumentState,
} from './protocol.js';

const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;
const BASE_RETRY_MS = 500;
const MAX_RETRY_MS = 30_000;
const remoteOrigin = Symbol('epicenter-document-sync-remote');

export type DocumentClientSocket = {
	readonly readyState: number;
	readonly protocol: string;
	binaryType: string;
	onopen: (() => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onerror: (() => void) | null;
	onclose:
		| ((event: { code: number; reason: string; wasClean: boolean }) => void)
		| null;
	send(data: Uint8Array): void;
	close(code?: number, reason?: string): void;
};

export type DocumentConnectionStatus =
	| 'connecting'
	| 'connected'
	| 'offline'
	| 'authentication-required'
	| 'revoked'
	| 'disposed';

export function connectRowDocument({
	document,
	baseUrl,
	credentials,
	nodeId,
	agentId,
	openSocket = openBrowserSocket,
	schedule = scheduleTimeout,
}: {
	document: RowDocument;
	baseUrl: string | URL;
	credentials: SyncCredentialProvider;
	nodeId: string;
	agentId?: string;
	openSocket?: (
		url: URL,
		protocols: string[],
	) => DocumentClientSocket | Promise<DocumentClientSocket>;
	schedule?: (task: () => void, delayMs: number) => () => void;
}) {
	const target = rowDocumentConnectionTarget(document);
	const address: DocumentAddress = target.address;
	const presenceListeners = new Set<(peers: readonly DocumentPeer[]) => void>();
	const statusListeners = new Set<(status: DocumentConnectionStatus) => void>();
	const firstConnection = Promise.withResolvers<void>();
	void firstConnection.promise.catch(() => undefined);
	let status: DocumentConnectionStatus = 'connecting';
	let socket: DocumentClientSocket | undefined;
	let cancelRetry: (() => void) | undefined;
	let retryAttempt = 0;
	let cycle = 0;
	let isDisposed = false;
	let isConnectedOnce = false;
	let handshakeComplete = false;
	let serverStateVector: Uint8Array | undefined;
	let currentAgentId = agentId;

	function setStatus(next: DocumentConnectionStatus): void {
		if (status === next) return;
		status = next;
		for (const listener of statusListeners) listener(next);
	}

	function send(frame: Parameters<typeof encodeDocumentFrame>[0]): void {
		if (socket?.readyState !== SOCKET_OPEN) return;
		socket.send(new Uint8Array(encodeDocumentFrame(frame)));
	}

	function isOverBound(): boolean {
		return exceedsDocumentBound(
			measureDocumentState(target.encodeStateAsUpdate()),
		);
	}

	function sendStateReply(): void {
		if (!handshakeComplete || serverStateVector === undefined || isOverBound())
			return;
		send({
			kind: 'sync-response',
			update: target.encodeStateAsUpdate(serverStateVector),
		});
	}

	function handleUpdate(update: Uint8Array, origin: unknown): void {
		if (origin === remoteOrigin || !handshakeComplete || isOverBound()) return;
		send({ kind: 'update', update });
	}

	function retry(): void {
		if (isDisposed || credentials.get() === undefined) return;
		setStatus('offline');
		const delay = Math.min(BASE_RETRY_MS * 2 ** retryAttempt, MAX_RETRY_MS);
		retryAttempt += 1;
		cancelRetry?.();
		cancelRetry = schedule(() => {
			cancelRetry = undefined;
			void connect();
		}, delay);
	}

	function closeCurrent(): void {
		const opened = socket;
		socket = undefined;
		if (opened === undefined) return;
		opened.onopen = null;
		opened.onmessage = null;
		opened.onerror = null;
		opened.onclose = null;
		if (opened.readyState !== SOCKET_CLOSED) opened.close();
	}

	function bind(opened: DocumentClientSocket, activeCycle: number): void {
		if (isDisposed || activeCycle !== cycle) {
			opened.close();
			return;
		}
		socket = opened;
		opened.binaryType = 'arraybuffer';
		handshakeComplete = false;
		serverStateVector = undefined;
		const onOpen = () => {
			if (opened.protocol !== DOCUMENT_SUBPROTOCOL) {
				opened.close();
				return;
			}
			send({ kind: 'sync-request', stateVector: target.encodeStateVector() });
		};
		opened.onopen = onOpen;
		opened.onmessage = (event) => {
			if (socket !== opened || isDisposed) return;
			try {
				const frame = decodeDocumentFrame(messageBytes(event.data));
				switch (frame.kind) {
					case 'sync-request':
						serverStateVector = frame.stateVector;
						if (handshakeComplete) sendStateReply();
						return;
					case 'sync-response':
						target.applyUpdate(frame.update, remoteOrigin);
						if (handshakeComplete) return;
						handshakeComplete = true;
						sendStateReply();
						send({
							kind: 'presence-publish',
							nodeId,
							...(currentAgentId === undefined
								? {}
								: { agentId: currentAgentId }),
						});
						retryAttempt = 0;
						setStatus('connected');
						if (!isConnectedOnce) {
							isConnectedOnce = true;
							firstConnection.resolve();
						}
						return;
					case 'update':
						target.applyUpdate(frame.update, remoteOrigin);
						return;
					case 'presence':
						for (const listener of presenceListeners) listener(frame.peers);
						return;
					case 'presence-publish':
						throw new TypeError('Server sent a client-only presence frame');
				}
			} catch {
				opened.close();
			}
		};
		opened.onerror = () => undefined;
		opened.onclose = () => {
			if (socket !== opened) return;
			socket = undefined;
			if (!isDisposed && activeCycle === cycle) retry();
		};
		if (opened.readyState === SOCKET_OPEN) onOpen();
	}

	async function connect(): Promise<void> {
		if (isDisposed) return;
		const bearer = credentials.get();
		if (bearer === undefined) {
			setStatus('authentication-required');
			return;
		}
		if (bearer.length === 0 || /[\s,]/.test(bearer)) {
			throw new TypeError(
				'Bearer cannot be represented as a WebSocket subprotocol',
			);
		}
		const activeCycle = ++cycle;
		setStatus('connecting');
		try {
			const opened = await openSocket(
				documentWebSocketUrl({ baseUrl, address }),
				[DOCUMENT_SUBPROTOCOL, `${BEARER_SUBPROTOCOL_PREFIX}${bearer}`],
			);
			bind(opened, activeCycle);
		} catch {
			if (!isDisposed && activeCycle === cycle) retry();
		}
	}

	function credentialsChanged(): void {
		if (isDisposed) return;
		cycle += 1;
		cancelRetry?.();
		cancelRetry = undefined;
		closeCurrent();
		if (credentials.get() === undefined) {
			setStatus('authentication-required');
			return;
		}
		void connect();
	}

	function dispose(nextStatus: 'disposed' | 'revoked' = 'disposed'): void {
		if (isDisposed) return;
		isDisposed = true;
		cycle += 1;
		cancelRetry?.();
		cancelRetry = undefined;
		stopUpdates();
		stopCredentials?.();
		stopRevocation();
		closeCurrent();
		setStatus(nextStatus);
		if (!isConnectedOnce)
			firstConnection.reject(new Error(`Document connection ${nextStatus}`));
	}

	const stopUpdates = target.observe(handleUpdate);
	const stopCredentials = credentials.subscribe?.(credentialsChanged);
	const stopRevocation = target.subscribeRevocation(() => dispose('revoked'));
	void connect();

	return {
		whenConnected: firstConnection.promise,
		get status(): DocumentConnectionStatus {
			return status;
		},
		subscribeStatus(listener: (next: DocumentConnectionStatus) => void) {
			statusListeners.add(listener);
			return () => statusListeners.delete(listener);
		},
		subscribePresence(listener: (peers: readonly DocumentPeer[]) => void) {
			presenceListeners.add(listener);
			return () => presenceListeners.delete(listener);
		},
		publishPresence(nextAgentId?: string): void {
			currentAgentId = nextAgentId;
			if (!handshakeComplete) return;
			send({
				kind: 'presence-publish',
				nodeId,
				...(nextAgentId === undefined ? {} : { agentId: nextAgentId }),
			});
		},
		dispose,
	};
}

function openBrowserSocket(
	url: URL,
	protocols: string[],
): DocumentClientSocket {
	return new WebSocket(url, protocols) as DocumentClientSocket;
}

function messageBytes(data: unknown): Uint8Array {
	if (data instanceof Uint8Array) return data;
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) {
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	}
	throw new TypeError('Document frames are binary');
}

function scheduleTimeout(task: () => void, delayMs: number): () => void {
	const timer = setTimeout(task, delayMs);
	return () => clearTimeout(timer);
}
