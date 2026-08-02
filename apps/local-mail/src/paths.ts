import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * `LOCAL_MAIL_DIR` beats the OS-appropriate application-data directory for
 * the mirror. Scoping the db by account email keeps multiple connected Gmail
 * accounts from colliding.
 *
 * macOS: `~/Library/Application Support/local-mail`
 * Linux/other: `$XDG_DATA_HOME/local-mail` or `~/.local/share/local-mail`
 */
export function resolveDataDir(): string {
	const env = process.env.LOCAL_MAIL_DIR;
	if (env && env.length > 0) return env;
	if (process.platform === 'darwin') {
		return join(homedir(), 'Library', 'Application Support', 'local-mail');
	}
	const xdg = process.env.XDG_DATA_HOME;
	if (xdg && xdg.length > 0) return join(xdg, 'local-mail');
	return join(homedir(), '.local', 'share', 'local-mail');
}

/**
 * One account's private directory: `<dataDir>/<accountEmail>/`. Three files live
 * here and only one of them is disposable: the versioned `mail.v<n>.db` mirror,
 * the durable `intent.db` holding triage Gmail has not been told about yet
 * (ADR-0198), and the `lock.db` naming the account's single reconciler.
 *
 * The account email names a directory, so it must be exactly one path segment:
 * emails reach here from Google's profile endpoint or a store-validated
 * override, and this guard keeps any other string from escaping the data dir.
 *
 * This is the whole of Local Mail's per-tenant naming, and every file under the
 * directory is derived from this one function, so the guard has a single owner.
 * What the mirror artifact inside is called is the mirror's business, not this
 * module's (ADR-0197).
 */
export function accountDir(dataDir: string, accountEmail: string): string {
	if (
		accountEmail.length === 0 ||
		accountEmail === '.' ||
		accountEmail === '..' ||
		accountEmail.includes('/') ||
		accountEmail.includes('\\')
	) {
		throw new Error(
			`Account email ${JSON.stringify(accountEmail)} cannot name a mirror directory.`,
		);
	}
	return join(dataDir, accountEmail);
}

/**
 * The default file token store: `credentials.json` at the data-dir root, sibling
 * to each account's `<accountEmail>/` mirror dir. Deliberately not inside the
 * mirror dir, so a read-only SQL surface over the mirror can never read it. Same
 * reasoning as `apps/local-books` (ADR-0062).
 */
export function credentialsFilePath(dataDir: string): string {
	return join(dataDir, 'credentials.json');
}

/** The 0600 machine-level provider-credentials file, sibling to credentials.json. */
export function providerFilePath(dataDir: string): string {
	return join(dataDir, 'provider.json');
}

/**
 * The account directory, created `0700` if missing, along with the data dir
 * above it. Everything that is about to open a file in it (the mirror, the
 * intent store, the lock) goes through here, so the mode is applied once rather
 * than restated per file.
 */
export function ensureAccountDir(
	dataDir: string,
	accountEmail: string,
): string {
	const dir = accountDir(dataDir, accountEmail);
	for (const path of [dataDir, dir]) {
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
