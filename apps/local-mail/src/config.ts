import { credentialsFilePath, resolveDataDir } from './paths.ts';

/**
 * Fully-resolved runtime configuration. Precedence is env > built-in defaults;
 * there is no `config.json` yet (local-books' file-config layer is not ported
 * until Phase 2's connect flow needs per-mode `clientId` selection). Base-URL
 * fields are overridable so tests can point the client at a mock Gmail server.
 *
 * Unlike `apps/local-books`' `AppConfig.entities` (a configurable QuickBooks
 * entity list), Gmail's mirrored set is fixed: messages and labels. There is
 * nothing to narrow, so no `entities` field exists here.
 */
export type AppConfig = {
	dataDir: string;
	/** Gmail REST API origin. */
	apiBase: string;
	/** Google OAuth2 authorization endpoint. */
	authorizeUrl: string;
	/** Google OAuth2 token endpoint (refresh-token exchange). */
	tokenUrl: string;
	/**
	 * Force a FULL pull once the time since the last successful sync exceeds
	 * this many days. Gmail's `historyId` retention is "at least a week, often
	 * longer" (not a fixed number like QuickBooks' 30-day CDC window), so this
	 * measures wall-clock staleness of our own last poll rather than trying to
	 * parse an age out of the opaque `historyId` cursor itself.
	 */
	historySafeWindowDays: number;
	/** Force a FULL pull this many days after the last one, as a correctness backstop. */
	fullBackstopDays: number;
	/** `messages.list` / `history.list` page size; Gmail caps at 500. */
	pageSize: number;
	/** Absolute path to the `0600` `credentials.json` holding the account's OAuth tokens. */
	credentialsPath: string;
	account: string | null;
	/**
	 * Disable Gmail mutations while keeping local reads and mirror refreshes
	 * available. `LOCAL_MAIL_READ_ONLY`.
	 */
	readOnly: boolean;
};

const DEFAULT_API_BASE = 'https://gmail.googleapis.com';
const DEFAULT_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token';

function env(name: string): string | undefined {
	const value = process.env[name];
	return value && value.length > 0 ? value : undefined;
}

function envFlag(name: string): boolean | undefined {
	const value = env(name);
	if (value === undefined) return undefined;
	return !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
}

export function loadConfig(): AppConfig {
	const dataDir = resolveDataDir();

	return {
		dataDir,
		// The Google OAuth client keys are NOT read here: they are resolved lazily
		// at the connect/refresh site from GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET.
		// The env override exists for the MCP subprocess test, which cannot
		// inject an AppConfig in-process. The OAuth endpoints have no such
		// consumer: in-process tests override the AppConfig fields directly.
		apiBase: env('LOCAL_MAIL_GMAIL_API_BASE') ?? DEFAULT_API_BASE,
		authorizeUrl: DEFAULT_AUTHORIZE_URL,
		tokenUrl: DEFAULT_TOKEN_URL,
		historySafeWindowDays: 5,
		fullBackstopDays: 30,
		pageSize: 100,
		credentialsPath:
			env('LOCAL_MAIL_TOKEN_FILE') ?? credentialsFilePath(dataDir),
		account: env('LOCAL_MAIL_ACCOUNT') ?? null,
		readOnly: envFlag('LOCAL_MAIL_READ_ONLY') ?? false,
	};
}
