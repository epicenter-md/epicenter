/**
 * The private Rust-to-Bun startup protocol and the Bun sidecar lifecycle.
 * Rust resolves the runtime mode and port, then keeps stdin open as its parent
 * lifetime signal. Bun validates that input but never resolves a port itself.
 */

export const SIDECAR_PROTOCOL_VERSION = 1;
export const PRODUCTION_PORT = 39_130;

export type SidecarRuntimeMode = 'production' | 'development';

export type BootFrame = {
	type: 'boot';
	protocolVersion: typeof SIDECAR_PROTOCOL_VERSION;
	token: string;
	port: number;
};

export type ReadyFrame = {
	type: 'ready';
	protocolVersion: typeof SIDECAR_PROTOCOL_VERSION;
	port: number;
};

type SidecarServer = {
	stop(closeActiveConnections?: boolean): Promise<void> | void;
};

type SidecarHost = {
	[Symbol.asyncDispose](): Promise<void>;
};

type SignalSource = {
	once(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
	off(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
};

export type ParentPipe = {
	bootLine: Promise<string>;
	closed: Promise<void>;
	cancel(): Promise<void>;
};

const BOOT_FRAME_KEYS = ['port', 'protocolVersion', 'token', 'type'];
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Parse the one explicit runtime-mode argument supplied by the Rust parent.
 * The full argv works for both Bun source runs (`bun`, script, args) and
 * compiled executables (executable, args), whose leading shapes differ.
 */
export function parseRuntimeMode(argv: string[]): SidecarRuntimeMode {
	const runtimeModeArguments = argv.filter((argument) =>
		argument.startsWith('--runtime-mode='),
	);
	if (runtimeModeArguments.length !== 1) {
		throw new Error(
			'Expected exactly one --runtime-mode=production|development argument.',
		);
	}

	switch (runtimeModeArguments[0]) {
		case '--runtime-mode=production':
			return 'production';
		case '--runtime-mode=development':
			return 'development';
		default:
			throw new Error(
				'Expected --runtime-mode=production or --runtime-mode=development.',
			);
	}
}

/** Strictly validate the first stdin line as protocol version 1. */
export function parseBootFrame(
	line: string,
	runtimeMode: SidecarRuntimeMode,
): BootFrame {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		throw new Error('The boot frame must be valid JSON.');
	}

	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('The boot frame must be a JSON object.');
	}

	const keys = Object.keys(value).sort();
	if (
		keys.length !== BOOT_FRAME_KEYS.length ||
		keys.some((key, index) => key !== BOOT_FRAME_KEYS[index])
	) {
		throw new Error(
			'The boot frame must contain exactly type, protocolVersion, token, and port.',
		);
	}

	const frame = value as Record<string, unknown>;
	if (frame.type !== 'boot') {
		throw new Error('The boot frame type must be "boot".');
	}
	if (frame.protocolVersion !== SIDECAR_PROTOCOL_VERSION) {
		throw new Error(
			`Unsupported boot protocol version: ${String(frame.protocolVersion)}.`,
		);
	}
	if (typeof frame.token !== 'string' || !BASE64URL.test(frame.token)) {
		throw new Error('The boot token must be a non-empty base64url string.');
	}
	if (
		typeof frame.port !== 'number' ||
		!Number.isInteger(frame.port) ||
		frame.port < 1_024 ||
		frame.port > 65_535
	) {
		throw new Error(
			'The boot port must be an integer from 1024 through 65535.',
		);
	}
	if (runtimeMode === 'production' && frame.port !== PRODUCTION_PORT) {
		throw new Error(`Production must bind port ${PRODUCTION_PORT}.`);
	}

	return frame as BootFrame;
}

export function createReadyFrame(port: number): ReadyFrame {
	return {
		type: 'ready',
		protocolVersion: SIDECAR_PROTOCOL_VERSION,
		port,
	};
}

/**
 * Read the first newline-terminated boot frame and then keep consuming stdin.
 * `closed` resolves only when the Rust-owned pipe reaches EOF.
 */
export function watchParentPipe(
	stream: ReadableStream<Uint8Array>,
): ParentPipe {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let isBootSettled = false;
	const boot = Promise.withResolvers<string>();

	const closed = (async (): Promise<void> => {
		let buffer = '';
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (value && !isBootSettled) {
					buffer += decoder.decode(value, { stream: true });
				}

				const newline = buffer.indexOf('\n');
				if (!isBootSettled && newline !== -1) {
					isBootSettled = true;
					boot.resolve(buffer.slice(0, newline).replace(/\r$/, ''));
					buffer = '';
				}

				if (!done) continue;
				if (!isBootSettled) {
					isBootSettled = true;
					boot.reject(
						new Error('The parent pipe closed before a complete boot line.'),
					);
				}
				return;
			}
		} catch (error) {
			if (!isBootSettled) {
				isBootSettled = true;
				boot.reject(
					error instanceof Error
						? error
						: new Error('Failed to read the parent pipe.'),
				);
			}
		}
	})();

	return {
		bootLine: boot.promise,
		closed,
		async cancel() {
			await reader.cancel();
		},
	};
}

/** Wait for a parent exit signal, then stop accepting work and release state. */
export async function superviseSidecar({
	server,
	host,
	parentPipe,
	signals = process,
}: {
	server: SidecarServer;
	host: SidecarHost;
	parentPipe: ParentPipe;
	signals?: SignalSource;
}): Promise<void> {
	const shutdownRequested = Promise.withResolvers<void>();
	const onSignal = () => shutdownRequested.resolve();
	signals.once('SIGTERM', onSignal);
	signals.once('SIGINT', onSignal);
	void parentPipe.closed.then(shutdownRequested.resolve);

	try {
		await shutdownRequested.promise;
		try {
			await server.stop(true);
		} finally {
			await host[Symbol.asyncDispose]();
		}
	} finally {
		signals.off('SIGTERM', onSignal);
		signals.off('SIGINT', onSignal);
		await parentPipe.cancel();
	}
}
