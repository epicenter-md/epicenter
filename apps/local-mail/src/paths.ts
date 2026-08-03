import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
	appDataDir,
	epicenterDataRoot,
	partitionDir,
} from '@epicenter/constants/app-data';

/**
 * Local Mail's one directory: `<epicenter-root>/apps/local-mail`.
 *
 * The app computes no OS application-data path of its own. Epicenter owns
 * exactly one root and `EPICENTER_DATA_DIR` is the only override, so a CLI run
 * from a terminal and the desktop host operate on the same mailbox (ADR-0201).
 * Everything below the result belongs to this app, and nothing outside it
 * receives a path into it.
 */
export function mailDataDir(): string {
	return appDataDir(epicenterDataRoot(), 'local-mail');
}

/** The word Local Mail partitions by. One directory, so an app-root filename
 * and an account can never collide and listing accounts is a directory read. */
const ACCOUNTS = 'accounts';

/** `<dataDir>/accounts`, the parent every account partition sits under. */
export function accountsDir(dataDir: string): string {
	return join(dataDir, ACCOUNTS);
}

/**
 * One account's private partition: `<dataDir>/accounts/<accountEmail>/`. Three
 * files live here and only one of them is disposable: the versioned
 * `mail.v<n>.db` mirror, the durable `intent.db` holding triage Gmail has not
 * been told about yet (ADR-0198), and the `lock.db` naming the account's single
 * reconciler.
 *
 * The account email names a directory, so the shared `partitionDir` guard
 * validates it as exactly one path component: emails reach here from Google's
 * profile endpoint or a store-validated override, and that guard keeps any other
 * string from escaping the app's directory.
 *
 * The email is not an identifier Google promises to keep, which is the defect
 * ADR-0201 records and has not yet fixed; adopting the `sub` claim is a separate
 * wave that costs a re-consent per account.
 *
 * This is the whole of Local Mail's per-tenant naming, and every file under the
 * directory is derived from this one function, so the guard has a single owner.
 * What the mirror artifact inside is called is the mirror's business, not this
 * module's (ADR-0197).
 */
export function accountDir(dataDir: string, accountEmail: string): string {
	return partitionDir(dataDir, ACCOUNTS, accountEmail);
}

/**
 * The default file token store: `credentials.json` at the app-directory root,
 * sibling to `accounts/`. Deliberately not inside a partition, so a read-only SQL
 * surface over the mirror can never read it. Same reasoning as
 * `apps/local-books` (ADR-0062).
 */
export function credentialsFilePath(dataDir: string): string {
	return join(dataDir, 'credentials.json');
}

/** The 0600 machine-level provider-credentials file, sibling to credentials.json. */
export function providerFilePath(dataDir: string): string {
	return join(dataDir, 'provider.json');
}

/**
 * The `0600` presence file a running `local-mail app` publishes, sibling to
 * `credentials.json`. It is runtime state rather than app data: a stale one
 * names a dead port and the next launch overwrites it (`presence.ts`).
 */
export function presenceFilePath(dataDir: string): string {
	return join(dataDir, 'runtime.json');
}

/**
 * The account directory, created `0700` if missing, along with `accounts/` and
 * the app directory above it. Everything that is about to open a file in it (the
 * mirror, the intent store, the lock) goes through here, so the mode is applied
 * once rather than restated per file, and so a directory that pre-existed with
 * looser permissions is tightened rather than trusted.
 */
export function ensureAccountDir(
	dataDir: string,
	accountEmail: string,
): string {
	const dir = accountDir(dataDir, accountEmail);
	for (const path of [dataDir, accountsDir(dataDir), dir]) {
		mkdirSync(path, { recursive: true, mode: 0o700 });
		chmodSync(path, 0o700);
	}
	return dir;
}

/**
 * Restrict a SQLite file and its WAL sidecars to the owner. Both files under an
 * account directory hold someone's mail or their pending changes to it, so both
 * are `0600`; the mirror primitive deliberately does not decide sensitivity for
 * the app (ADR-0197). Missing sidecars are skipped: a database has no
 * `-wal`/`-shm` until it is written.
 */
export function secureDbFiles(path: string): void {
	for (const file of [path, `${path}-wal`, `${path}-shm`]) {
		try {
			chmodSync(file, 0o600);
		} catch (error) {
			if ((error as { code?: unknown }).code !== 'ENOENT') throw error;
		}
	}
}
