import { Err, Ok, type Result } from 'wellcrafted/result';
import { type AppConfig, loadConfig } from './config.ts';
import { type AccountApi, type ApiApp, createApiApp } from './http/api.ts';
import { acquireSyncLock, type SyncLock } from './lock.ts';
import {
	type LocalMailRuntime,
	openSyncSession,
	runtimeForAccount,
	type SyncSession,
} from './runtime.ts';
import { syncMailbox } from './sync.ts';
import { createFileTokenStore, type TokenStore } from './token-store.ts';

/**
 * The running mail engine: every connected account opened, its mountable HTTP
 * surface, and the sync loops keeping the mirrors fresh.
 *
 * This is the whole of what a host needs from Local Mail. Two hosts open one
 * (ADR-0191): `app.ts`, the standalone loopback host, which adds a per-launch
 * bearer and serves the SPA from disk; and the Epicenter host, which mounts the
 * surface on its own trusted origin behind the session it already requires. The
 * engine itself knows about neither, so neither can drift from the other on what
 * "an open account" means.
 *
 * The loop runs for the engine's lifetime, which is the host process's lifetime.
 * ADR-0116 originally tied it to a Local Mail window being open; ADR-0191
 * withdrew that for the host process that owns the engine.
 */

const SYNC_INTERVAL_MS = 30_000;

export type MailEngine = {
	/** The mail surface, prefix-free and unauthenticated. The host mounts it
	 * where it wants and applies its own gate (ADR-0191). */
	api: ApiApp;
	/** The accounts this engine actually opened, in load order. An account that
	 * failed to open is absent here and was reported through `log`. */
	accountEmails: string[];
	/**
	 * Stop every loop, close every session, release every held sync lock.
	 *
	 * Async because a sync pass may be in flight, and closing its session out
	 * from under it finalizes the statements it is still using. So this drains
	 * each account's gate first: the gate serializes, so an empty job enqueued
	 * behind the in-flight pass resolves only once that pass has settled.
	 */
	close(): Promise<void>;
};

/** `Bun.sleep` that gives up when the engine closes, so a shutdown never waits
 * out a full poll interval and no pending timer keeps the host alive. */
function sleepUntilAborted(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const timer = setTimeout(finish, ms);
		function finish() {
			clearTimeout(timer);
			signal.removeEventListener('abort', finish);
			resolve();
		}
		signal.addEventListener('abort', finish, { once: true });
	});
}

/**
 * One in-process promise chain per account: the background loop and a
 * "refresh now" request both enqueue here, so at most one sync pass touches
 * that mirror at a time. No coalescing (a refresh may ride a pass that started
 * before the click); the spec accepts that for v1.
 */
function createSyncGate() {
	let tail: Promise<unknown> = Promise.resolve();
	return function run<T>(fn: () => Promise<T>): Promise<T> {
		const result = tail.then(fn, fn);
		tail = result.catch(() => {});
		return result;
	};
}

/**
 * One account's slice of the running engine: its runtime, its open sync session
 * (writer db + Gmail client), its per-account serialize gate, and the sync-owner
 * lock IF this engine won it. `lock === null` means another owner (a headless
 * `sync`) holds the loop for that account; the engine still serves its reads and
 * Gmail-first writes (both lock-free), it just runs no loop for it.
 */
type AccountEngine = {
	runtime: LocalMailRuntime;
	session: SyncSession;
	gate: <T>(fn: () => Promise<T>) => Promise<T>;
	lock: SyncLock | null;
};

/**
 * The accounts to open: every connected account by default, or only
 * `LOCAL_MAIL_ACCOUNT` when that single-account override is set (the same escape
 * hatch the CLI and tests use, honored here too). Enumerated once at open, so an
 * account connected later appears on the next host restart.
 */
async function selectAccounts(
	config: AppConfig,
	store: TokenStore,
): Promise<Result<string[], { message: string }>> {
	const connected = await store.listAccounts();
	if (connected.length === 0) {
		return Err({
			message: 'No Gmail account connected. Run "local-mail connect" first.',
		});
	}
	if (config.account) {
		if (!connected.includes(config.account)) {
			return Err({
				message: `LOCAL_MAIL_ACCOUNT is set to ${config.account}, which is not a connected account (connected: ${connected.join(', ')}).`,
			});
		}
		return Ok([config.account]);
	}
	return Ok(connected);
}

/**
 * Open every connected mailbox and start its sync loop.
 *
 * Errs only when no account could be opened at all: with no account connected,
 * or with every candidate failing. One account failing among several is not an
 * error, because it must not cost a host the mailboxes that did open; it is
 * reported through `log` and left out of `accountEmails`. Epicenter depends on
 * that distinction, since a stale Gmail token is a user state, not a release
 * defect, and must not sink a host that serves far more than mail.
 *
 * `log` is injected rather than written to the console, because this is library
 * code and its two hosts narrate differently.
 */
export async function openMailEngine(options: {
	log: (message: string) => void;
}): Promise<Result<MailEngine, { message: string }>> {
	const { log } = options;
	const config = loadConfig();
	const store = createFileTokenStore(config.credentialsPath);

	const { data: accountEmails, error: accountsError } = await selectAccounts(
		config,
		store,
	);
	if (accountsError) return Err(accountsError);

	const controller = new AbortController();
	// One engine per account, all under one surface. A per-account gate keeps
	// each mirror single-writer while letting distinct accounts sync concurrently.
	const engines: AccountEngine[] = [];
	for (const accountEmail of accountEmails) {
		const runtime = runtimeForAccount(config, store, accountEmail);
		const { data: session, error: sessionError } = await openSyncSession(
			runtime,
			{
				gmailLog: (m) => log(`[gmail ${accountEmail}] ${m}`),
				syncLog: (m) => log(`[sync ${accountEmail}] ${m}`),
			},
		);
		if (sessionError) {
			// One account failing to open (e.g. its token vanished between the store
			// listing and now) must not sink the rest; log it and serve the others.
			log(`Skipping ${accountEmail}: ${sessionError.message}`);
			continue;
		}
		const lock = acquireSyncLock({ dataDir: config.dataDir, accountEmail });
		engines.push({ runtime, session, gate: createSyncGate(), lock });
	}

	if (engines.length === 0) {
		return Err({
			message: 'No account could be opened. Run "local-mail connect" first.',
		});
	}

	const api = createApiApp({
		accounts: new Map<string, AccountApi>(
			engines.map((engine) => [
				engine.runtime.accountEmail,
				{
					runtime: engine.runtime,
					syncDeps: engine.session.deps,
					gate: engine.gate,
					ownsLoop: engine.lock !== null,
				},
			]),
		),
		readOnly: config.readOnly,
	});

	// One background loop per account this engine won the lock for, each
	// serialized through its own gate (the same gate its POST .../sync rides).
	// An account whose loop is owned elsewhere is still served; that other owner
	// keeps its mirror fresh.
	for (const engine of engines) {
		if (!engine.lock) {
			log(
				`[sync ${engine.runtime.accountEmail}] loop owned elsewhere; serving reads only.`,
			);
			continue;
		}
		const { session, gate, runtime } = engine;
		(async () => {
			while (!controller.signal.aborted) {
				await gate(() => syncMailbox(session.deps, { forceFull: false })).catch(
					(cause) =>
						log(`[sync ${runtime.accountEmail}] loop pass failed: ${cause}`),
				);
				if (controller.signal.aborted) break;
				await sleepUntilAborted(SYNC_INTERVAL_MS, controller.signal);
			}
		})();
	}

	return Ok({
		api,
		accountEmails: engines.map((engine) => engine.runtime.accountEmail),
		async close() {
			controller.abort();
			// Wait out any pass already running before its statements go away.
			await Promise.allSettled(
				engines.map((engine) => engine.gate(async () => {})),
			);
			for (const engine of engines) {
				engine.session.close();
				engine.lock?.release();
			}
		},
	});
}
