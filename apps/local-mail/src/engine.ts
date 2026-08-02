import { Err, Ok, type Result } from 'wellcrafted/result';
import { type AppConfig, loadConfig } from './config.ts';
import { type AccountApi, type ApiApp, createApiApp } from './http/api.ts';
import { acquireSyncLock, type SyncLock } from './lock.ts';
import { beginAuthorizationFlow } from './oauth.ts';
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
	/** The accounts currently in service, in admission order. An account that
	 * failed to open is absent and was reported through `log`. Live rather than a
	 * boot snapshot: a mailbox connected through the surface appears here without
	 * a restart. */
	readonly accountEmails: string[];
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
 * The accounts to open at boot: every connected account by default, or only
 * `LOCAL_MAIL_ACCOUNT` when that single-account override is set (the same escape
 * hatch the CLI and tests use, honored here too).
 *
 * No connected account is an empty list, not an error. A device where nobody has
 * signed in to Gmail yet is the first-run state, and the engine has to open
 * anyway so `connect` has something to run on.
 */
async function selectAccounts(
	config: AppConfig,
	store: TokenStore,
): Promise<Result<string[], { message: string }>> {
	const connected = await store.listAccounts();
	if (connected.length === 0) return Ok([]);
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
 * Open every connected mailbox, start its sync loop, and stay open.
 *
 * Opening succeeds even with no account at all. A device where nobody has
 * connected Gmail yet is the first-run state, and it is exactly the state where
 * `connect` needs to be reachable, so refusing to open would make the one action
 * that fixes it impossible to offer. An account that fails to open is reported
 * through `log` and left out; it never costs a host the mailboxes that did open,
 * because a stale Gmail token is a user state rather than a release defect.
 *
 * Errs only on a configuration mistake the caller must fix: `LOCAL_MAIL_ACCOUNT`
 * naming an account nobody has connected.
 *
 * `log` is injected rather than written to the console, because this is library
 * code and its hosts narrate differently.
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
	// One entry per open account, read at request time by the surface, so an
	// account admitted after boot is live on the next request rather than the
	// next restart.
	const accounts = new Map<string, AccountApi>();
	const engines: AccountEngine[] = [];

	/**
	 * Open one mailbox and put it into service: its sync session, its serialize
	 * gate, its sync-owner lock if this engine wins it, and its poll loop.
	 *
	 * The one path into service, used by boot and by `connect` alike, so a
	 * freshly connected account is opened exactly the way a boot-time one is.
	 */
	async function admit(
		accountEmail: string,
	): Promise<Result<void, { message: string }>> {
		if (accounts.has(accountEmail)) return Ok(undefined);
		const runtime = runtimeForAccount(config, store, accountEmail);
		const { data: session, error: sessionError } = await openSyncSession(
			runtime,
			{
				gmailLog: (m) => log(`[gmail ${accountEmail}] ${m}`),
				syncLog: (m) => log(`[sync ${accountEmail}] ${m}`),
			},
		);
		if (sessionError) return Err({ message: sessionError.message });

		const lock = acquireSyncLock({ dataDir: config.dataDir, accountEmail });
		const gate = createSyncGate();
		const engine: AccountEngine = { runtime, session, gate, lock };
		engines.push(engine);
		accounts.set(accountEmail, {
			runtime,
			syncDeps: session.deps,
			gate,
			ownsLoop: lock !== null,
		});

		// An account whose loop is owned elsewhere is still served; that other
		// owner keeps its mirror fresh.
		if (!lock) {
			log(`[sync ${accountEmail}] loop owned elsewhere; serving reads only.`);
			return Ok(undefined);
		}
		// Serialized through the same gate its POST .../sync rides.
		void (async () => {
			while (!controller.signal.aborted) {
				await gate(() => syncMailbox(session.deps, { forceFull: false })).catch(
					(cause) => log(`[sync ${accountEmail}] loop pass failed: ${cause}`),
				);
				if (controller.signal.aborted) break;
				await sleepUntilAborted(SYNC_INTERVAL_MS, controller.signal);
			}
		})();
		return Ok(undefined);
	}

	for (const accountEmail of accountEmails) {
		const { error } = await admit(accountEmail);
		// One account failing to open (e.g. its token vanished between the store
		// listing and now) must not sink the rest; log it and serve the others.
		if (error) log(`Skipping ${accountEmail}: ${error.message}`);
	}

	/**
	 * Run Gmail's consent flow and put the resulting mailbox into service.
	 *
	 * Returns as soon as there is somewhere to send the person, because the
	 * browser may take minutes and may not open at all on this platform. The
	 * exchange and the admission finish in the background; the caller watches
	 * `GET /accounts` for the new mailbox to appear.
	 */
	async function connect(): Promise<
		Result<{ authorizeUrl: string }, { message: string }>
	> {
		const { data: flow, error } = await beginAuthorizationFlow(config, {
			now: () => Date.now(),
			log,
		});
		if (error) return Err({ message: error.message });

		void (async () => {
			const { data: token, error: grantError } = await flow.completed;
			if (grantError) {
				log(`[connect] ${grantError.message}`);
				return;
			}
			await store.set(token);
			const { error: admitError } = await admit(token.accountEmail);
			if (admitError) {
				log(`[connect] ${token.accountEmail}: ${admitError.message}`);
				return;
			}
			log(`[connect] ${token.accountEmail} connected.`);
		})();

		return Ok({ authorizeUrl: flow.authorizeUrl });
	}

	const api = createApiApp({
		accounts,
		readOnly: config.readOnly,
		connect,
	});

	return Ok({
		api,
		get accountEmails() {
			return [...accounts.keys()];
		},
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
