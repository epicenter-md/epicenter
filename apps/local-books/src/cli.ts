import ms from 'ms';
import { runAuth } from './commands/auth.ts';
import { runDaemon } from './commands/daemon.ts';
import { runDemo } from './commands/demo.ts';
import { runMcpServer } from './commands/mcp.ts';
import { runQuery } from './commands/query.ts';
import { runRecategorize } from './commands/recategorize.ts';
import { runReport } from './commands/report.ts';
import { runStatus } from './commands/status.ts';
import { runSync } from './commands/sync.ts';
import type { QbEnvironment } from './config.ts';

/** Parsed command-line arguments shared by the command handlers. */
export type ParsedArgs = {
	command: string;
	/** Non-flag arguments after the command (e.g. the SQL, a report name, an id). */
	positionals: string[];
	full: boolean;
	entities: string[];
	/** When set, `sync` loops on this interval (ms) instead of running once. */
	intervalMs?: number;
	/** The port `daemon` serves its HTTP `/mcp` endpoint on. */
	httpPort?: number;
	dataDir?: string;
	realm?: string;
	environment?: QbEnvironment;
	/** `report` period bounds (YYYY-MM-DD) and basis. */
	start?: string;
	end?: string;
	method?: string;
	/** `recategorize` target account and optional line. */
	to?: string;
	toName?: string;
	line?: string;
	help: boolean;
	version: boolean;
};

export const VERSION = '0.0.1';

const HELP = `local-books: keep a private local copy of your QuickBooks books, then grill it.

Usage:
  local-books auth [options]
  local-books sync [--full] [--entity <name>]... [options]
  local-books status [options]
  local-books query "<sql>" [options]
  local-books report <Name> [--start <date>] [--end <date>] [--method <basis>]
  local-books recategorize <Purchase|Bill> <id> --to <accountId> [options]
  local-books demo [options]
  local-books mcp [options]
  local-books daemon --http-port <port> [options]

First run:
  local-books demo                          See it work on a sample company, no QuickBooks needed.
  local-books auth                          Connect your company, then:
  local-books sync --full                   Pull your books into the local copy.

Commands:
  auth          Connect a QuickBooks company once (opens a browser). Saves tokens to a 0600 credentials file.
  sync          Refresh the local copy. Full vs incremental is chosen automatically; --full forces full.
  status        Show connection state, what is synced, and row counts.
  query         Run a read-only SQL query over the local copy (point an AI agent here too).
  report        Run a live QuickBooks statement: ProfitAndLoss, BalanceSheet, CashFlow, AgedReceivables, AgedPayables, TrialBalance.
  recategorize  Move an expense to a different account in QuickBooks (then update the local copy).
  demo          Build a sample company you can query right now, with example questions.
  mcp           Serve the read/refresh/write verbs to a coding agent over MCP (stdio). See the README.
  daemon        Serve the same MCP verbs over a private HTTP /mcp endpoint (for your other devices over Tailscale). See the README.

Options:
  --full                          Force a full pull (sync only).
  --entity <name>                 Limit sync to these record types (repeatable). Default: all.
  --interval <dur>                Keep syncing on a loop, e.g. 30m or 1h (sync only; Ctrl-C to stop).
  --http-port <port>              Port for the HTTP /mcp endpoint (daemon only).
  --start <YYYY-MM-DD>            Report period start (report only).
  --end <YYYY-MM-DD>              Report period end (report only).
  --method <Cash|Accrual>         Report basis (report only; defaults to the company setting).
  --to <accountId>                Target account for recategorize (an accounts row id).
  --to-name <name>                Target account display name for recategorize (optional, for readable books).
  --line <lineId>                 Recategorize only this expense line (optional; default all expense lines).
  --realm <id>                    Target company (default: the connected one).
  --data-dir <path>               Where the local copy lives (or LOCAL_BOOKS_DIR).
  --qb-env <sandbox|production>   Which QuickBooks to talk to (default: sandbox). Was --env.
  -h, --help                      Show this help.
  -v, --version                   Show version.

Environment:
  QB_CLIENT_ID / QB_CLIENT_SECRET   Your Intuit app keys (required for auth). See the README.
  LOCAL_BOOKS_DIR                   Where the local copy lives.
  LOCAL_BOOKS_TOKEN_FILE            Override the credentials file path (default: <data-dir>/credentials.json).
  LOCAL_BOOKS_READ_ONLY             Disable recategorize (reads only).
  LOCAL_BOOKS_CORS_ORIGIN           Comma-separated browser origin allowlist for the daemon (default: reflect any).
`;

/** Parse a duration like "30s", "30m", "2h" into ms; a bare number means minutes. */
export function parseInterval(input: string): number {
	const trimmed = input.trim();
	// A bare number means minutes ("30" -> "30m"); ms handles the unit suffixes.
	const normalized = /^\d+$/.test(trimmed) ? `${trimmed}m` : trimmed;
	const result = ms(normalized as Parameters<typeof ms>[0]) as
		| number
		| undefined;
	if (result == null || !Number.isFinite(result) || result <= 0) {
		throw new Error(
			`Invalid --interval "${input}". Use e.g. 30, 30s, 30m, or 2h.`,
		);
	}
	return result;
}

export function parseArgs(argv: string[]): ParsedArgs {
	const args: ParsedArgs = {
		command: '',
		positionals: [],
		full: false,
		entities: [],
		help: false,
		version: false,
	};

	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i] as string;

		if (!token.startsWith('-')) {
			if (!args.command) args.command = token;
			else args.positionals.push(token);
			continue;
		}

		const eq = token.startsWith('--') ? token.indexOf('=') : -1;
		const name = eq === -1 ? token : token.slice(0, eq);
		const inlineValue = eq === -1 ? undefined : token.slice(eq + 1);

		const takeValue = (): string => {
			if (inlineValue !== undefined) return inlineValue;
			const next = argv[i + 1];
			if (next === undefined) throw new Error(`Option ${name} needs a value`);
			i += 1;
			return next;
		};

		switch (name) {
			case '--full':
				args.full = true;
				break;
			case '-h':
			case '--help':
				args.help = true;
				break;
			case '-v':
			case '--version':
				args.version = true;
				break;
			case '--entity':
				args.entities.push(takeValue());
				break;
			case '--interval':
				args.intervalMs = parseInterval(takeValue());
				break;
			case '--http-port': {
				const value = takeValue();
				const port = Number(value);
				if (!Number.isInteger(port) || port < 0 || port > 65535) {
					throw new Error(
						`--http-port must be a port number (0-65535), got "${value}"`,
					);
				}
				args.httpPort = port;
				break;
			}
			case '--realm':
				args.realm = takeValue();
				break;
			case '--data-dir':
				args.dataDir = takeValue();
				break;
			case '--start':
				args.start = takeValue();
				break;
			case '--end':
				args.end = takeValue();
				break;
			case '--method':
				args.method = takeValue();
				break;
			case '--to':
				args.to = takeValue();
				break;
			case '--to-name':
				args.toName = takeValue();
				break;
			case '--line':
				args.line = takeValue();
				break;
			case '--qb-env': {
				const value = takeValue();
				if (value !== 'sandbox' && value !== 'production') {
					throw new Error(
						`--qb-env must be "sandbox" or "production", got "${value}"`,
					);
				}
				args.environment = value as QbEnvironment;
				break;
			}
			default:
				throw new Error(`Unknown option: ${name}`);
		}
	}

	return args;
}

export async function runCli(argv: string[]): Promise<number> {
	const args = parseArgs(argv);

	if (args.version) {
		console.log(VERSION);
		return 0;
	}
	if (args.help || !args.command) {
		console.log(HELP);
		return args.help ? 0 : 1;
	}

	switch (args.command) {
		case 'auth':
			return runAuth(args);
		case 'sync':
			return runSync(args);
		case 'status':
			return runStatus(args);
		case 'query':
			return runQuery(args);
		case 'report':
			return runReport(args);
		case 'recategorize':
			return runRecategorize(args);
		case 'demo':
			return runDemo(args);
		case 'mcp':
			return runMcpServer(args);
		case 'daemon':
			return runDaemon(args);
		default:
			console.error(`Unknown command: ${args.command}\n`);
			console.log(HELP);
			return 1;
	}
}
