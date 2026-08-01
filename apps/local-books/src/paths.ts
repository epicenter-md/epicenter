import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * OS-appropriate application-data directory for the mirror. Scoping the db by
 * `realmId` underneath keeps multiple QuickBooks companies from colliding.
 *
 * macOS: `~/Library/Application Support/local-books`
 * Linux/other: `$XDG_DATA_HOME/local-books` or `~/.local/share/local-books`
 */
export function defaultDataDir(): string {
	if (process.platform === 'darwin') {
		return join(homedir(), 'Library', 'Application Support', 'local-books');
	}
	const xdg = process.env['XDG_DATA_HOME'];
	if (xdg && xdg.length > 0) return join(xdg, 'local-books');
	return join(homedir(), '.local', 'share', 'local-books');
}

/** `--data-dir` beats `LOCAL_BOOKS_DIR` beats the OS default. */
export function resolveDataDir(override?: string): string {
	if (override && override.length > 0) return override;
	const env = process.env['LOCAL_BOOKS_DIR'];
	if (env && env.length > 0) return env;
	return defaultDataDir();
}

/**
 * One directory per company, scoped by `realmId` under the data dir. It holds
 * the company's mirror artifacts (named by corpus version, see `booksMirror` in
 * `db.ts`) and the `app` verb's `lock.db`. This is the directory the mirror is
 * opened at, so `realmId` is the only per-tenant naming the mirror sees.
 */
export function companyDir(dataDir: string, realmId: string): string {
	return join(dataDir, realmId);
}

/** Tracks which companies have been authenticated and which is the default. */
export function companiesFilePath(dataDir: string): string {
	return join(dataDir, 'companies.json');
}

/**
 * The default file token store: `credentials.json` at the data-dir root, sibling
 * to `companies.json`. Deliberately not inside a company's `<realmId>/` mirror
 * dir, so the agent's read-only SQL surface over the mirror can never read it
 * (and one company's mirror can be shared without its refresh token).
 */
export function credentialsFilePath(dataDir: string): string {
	return join(dataDir, 'credentials.json');
}
