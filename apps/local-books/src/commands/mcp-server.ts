/**
 * The books MCP server, transport-free.
 *
 * This module owns the tool table and the two JSON-RPC request handlers. It
 * builds a low-level `Server` and hands it back with no transport attached, so
 * the same server definition rides two transports:
 *  - `commands/mcp.ts` (`local-books mcp`) attaches a `StdioServerTransport`;
 *  - `commands/daemon.ts` (`local-books daemon`) attaches a Web-Standard
 *    Streamable HTTP transport, freshly per request (stateless mode).
 *
 * Everything that makes this an egress airlock and not a leak lives here, so it
 * holds for both transports identically: each tool's TypeBox `input` IS the MCP
 * `inputSchema` AND the validator (`Value.Check`); the read-only filter drops
 * the QuickBooks mutation from the catalog; unknown-tool / bad-args are protocol
 * errors while a tool that ran and failed is an `isError` result.
 *
 * It deliberately adds no `@epicenter/workspace`, no relay, no mesh: Local Books
 * is standalone (ADR-0072) and its financial data must never transit the relay
 * (ADR-0004, ADR-0073). A subprocess (or a private HTTPS endpoint on the user's
 * own box, reached directly over their tailnet) reading the local SQLite is the
 * only exposure that keeps the data on the machine.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
	CallToolRequestSchema,
	type CallToolResult,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { type Static, type TObject, Type } from 'typebox';
import { Value } from 'typebox/value';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { createQbAccess, type OpenQbClient } from '../books/qb-access.ts';
import { queryBooks } from '../books/query.ts';
import {
	RecategorizeInput,
	recategorizeExpense,
} from '../books/recategorize.ts';
import { fetchReport, ReportInput } from '../books/report.ts';
import { readBooksStatus } from '../books/status.ts';
import { VERSION } from '../cli.ts';
import { resolveRealm } from '../companies.ts';
import { type AppConfig } from '../config.ts';
import { openBooksDb } from '../db.ts';
import { dbPath } from '../paths.ts';
import { syncRealm } from '../sync.ts';
import { createFileTokenStore, type TokenStore } from '../token-store.ts';

/** What every tool `run` is handed: the resolved company plus its opened deps. */
type ToolContext = {
	config: AppConfig;
	realmId: string;
	/** The mirror db path for the resolved company. */
	dbPath: string;
	/** A QB client opener for the resolved company; the token loads when called. */
	openQb: OpenQbClient;
	/** The realm's token store (built once per server, reloaded on each `get`). */
	store: TokenStore;
	now: () => number;
};

/** A tool's outcome: any object on success, anything with a `message` on failure. */
type ToolOutcome = Result<unknown, { message: string }>;

type ToolDescriptor = {
	name: string;
	title: string;
	description: string;
	/** TypeBox object schema: serialized as the MCP `inputSchema` AND the validator. */
	input: TObject;
	/**
	 * The tool's effect class:
	 *  - `read`  pure read of the mirror or a live QB report;
	 *  - `write` side-effecting but safe (sync refreshes the local cache);
	 *  - `mutation` mutates QuickBooks itself, and is the one class read-only
	 *    mode withholds from the catalog.
	 * It drives the read-only filter and the published `annotations`
	 * (`destructiveHint` is true only for `mutation`).
	 */
	tier: 'read' | 'write' | 'mutation';
	run: (
		ctx: ToolContext,
		args: Record<string, unknown>,
	) => Promise<ToolOutcome>;
};

/**
 * One typed tool entry. The generic ties `run`'s `args` to `Static<input>`, so
 * each handler is checked against its own schema and no `run` body re-asserts
 * the input shape. The erased descriptor takes `Record<string, unknown>`; the
 * one `args as Static<S>` narrowing is sound because the dispatcher runs
 * `Value.Check(input, args)` before calling, so it stays the runtime boundary.
 */
function defineMcpTool<S extends TObject>(tool: {
	name: string;
	title: string;
	description: string;
	input: S;
	tier: 'read' | 'write' | 'mutation';
	run: (ctx: ToolContext, args: Static<S>) => Promise<ToolOutcome>;
}): ToolDescriptor {
	return { ...tool, run: (ctx, args) => tool.run(ctx, args as Static<S>) };
}

const TOOLS: ToolDescriptor[] = [
	defineMcpTool({
		name: 'query',
		title: 'Query the books',
		description:
			'Run a read-only SQL query against the local QuickBooks mirror (one table per record type: invoices, customers, bills, purchases, accounts, ...). Returns up to 1000 rows.',
		input: Type.Object({
			sql: Type.String({
				description: 'A read-only SQL SELECT over the local mirror.',
			}),
		}),
		tier: 'read',
		async run(ctx, args) {
			return queryBooks({ dbPath: ctx.dbPath, sql: args.sql });
		},
	}),
	defineMcpTool({
		name: 'status',
		title: 'Books status',
		description:
			'Report the connection state and how fresh the local mirror is (cursor, last sync, per-record-type row counts). Cheap; good for "are you connected and synced?".',
		input: Type.Object({}),
		tier: 'read',
		async run(ctx) {
			return Ok(
				await readBooksStatus({
					config: ctx.config,
					realmId: ctx.realmId,
					store: ctx.store,
				}),
			);
		},
	}),
	defineMcpTool({
		name: 'report',
		title: 'Run a QuickBooks report',
		description:
			'Run a computed financial statement live from QuickBooks (never mirrored). Choose ProfitAndLoss, BalanceSheet, CashFlow, AgedReceivables, AgedPayables, or TrialBalance.',
		input: ReportInput,
		tier: 'read',
		async run(ctx, args) {
			return fetchReport({ openQb: ctx.openQb, input: args });
		},
	}),
	defineMcpTool({
		name: 'sync',
		title: 'Refresh the books',
		description:
			'Refresh the local mirror from QuickBooks. Incremental by default (changes since the last cursor); pass full to force a complete re-pull. Side-effecting but safe: it only updates the local copy.',
		input: Type.Object({
			full: Type.Optional(
				Type.Boolean({
					description: 'Force a full re-pull instead of incremental CDC.',
				}),
			),
		}),
		tier: 'write',
		async run(ctx, args) {
			// The opener loads the token and returns a ready QB client, or a "run
			// auth" reason. No bespoke not-connected error.
			const { data: client, error } = await ctx.openQb();
			if (error !== null) return Err({ message: error });
			const db = openBooksDb(ctx.dbPath);
			try {
				const outcome = await syncRealm(
					{ db, client, config: ctx.config, now: ctx.now },
					{ forceFull: args.full ?? false },
				);
				return Ok(outcome);
			} finally {
				db.close();
			}
		},
	}),
	defineMcpTool({
		name: 'recategorize',
		title: 'Recategorize an expense',
		description:
			'Move an expense transaction (a Purchase or Bill) to a different account in QuickBooks, then fold the authoritative response back into the mirror. The one write-back. Unavailable when LOCAL_BOOKS_READ_ONLY is set.',
		input: RecategorizeInput,
		tier: 'mutation',
		async run(ctx, args) {
			// The catalog filter is the live gate: under read-only this tool is
			// unlisted, so this run only executes when readOnly is false. Passing
			// the real flag keeps the core as the invariant's single owner, so
			// removing the filter later cannot silently enable the write.
			return recategorizeExpense({
				openQb: ctx.openQb,
				dbPath: ctx.dbPath,
				readOnly: ctx.config.readOnly,
				input: args,
			});
		},
	}),
];

/** Map a core's `Result` onto MCP's `CallToolResult` (the `isError` channel). */
function toCallResult({ data, error }: ToolOutcome): CallToolResult {
	if (error) {
		return { content: [{ type: 'text', text: error.message }], isError: true };
	}
	// Every core returns an object, which is what MCP requires of
	// `structuredContent`. Re-add an object guard if a scalar/array tool lands.
	return {
		content: [{ type: 'text', text: JSON.stringify(data) }],
		structuredContent: data as Record<string, unknown>,
	};
}

/** The per-server deps the tool handlers close over: the realm token store and a clock. */
export type BooksServerDeps = {
	config: AppConfig;
	/** The realm's token store; reloads from disk on each `get`. */
	store: TokenStore;
	/** Shared clock; injectable for tests. */
	now: () => number;
};

/**
 * Build the deps a books MCP server closes over from a resolved config. The
 * token store reloads on each `get`, so it is cheap to build, and the daemon
 * builds it once and reuses it across every per-request server.
 */
export function createBooksServerDeps(config: AppConfig): BooksServerDeps {
	return {
		config,
		store: createFileTokenStore(config.credentialsPath),
		now: () => Date.now(),
	};
}

/**
 * Build a fresh, transport-free books MCP `Server`.
 *
 * The low-level `Server` is deliberate (its `@deprecated` tag nudges casual
 * users to the high-level `McpServer`, but explicitly keeps `Server` for
 * advanced use): only this path lets each tool's `inputSchema` be the TypeBox
 * object passed straight through, with our own `Value.Check` and error model.
 *
 * Cheap to call repeatedly: the stateless HTTP transport is single-use per
 * request (it throws on reuse), so the daemon calls this once per request. No
 * file I/O happens here; the deps carry the already-opened store and clock.
 */
export function buildBooksServer(deps: BooksServerDeps): Server {
	// Read-only mode drops the QuickBooks mutation from the catalog entirely, so a
	// foreign host never even sees it. This filter is the live gate (the cores stay
	// the invariant's owner for the CLI path). Both transports inherit it because
	// it lives here, not in either transport wrapper.
	const tools = TOOLS.filter(
		(t) => t.tier !== 'mutation' || !deps.config.readOnly,
	);

	const server = new Server(
		{ name: 'local-books', version: VERSION },
		{ capabilities: { tools: {} } },
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: tools.map((t) => ({
			name: t.name,
			title: t.title,
			description: t.description,
			inputSchema: t.input,
			// Standard host-facing safety hints. `destructiveHint` is the honest
			// query-vs-mutation bit a host (and, later, our own chat) reads for its
			// approval UX: only the QuickBooks write-back is destructive; sync is a
			// safe local refresh. (ADR-0073's "never trust readOnlyHint" is about a
			// FOREIGN tool's inbound hint, not publishing our own honest one.)
			annotations: {
				readOnlyHint: t.tier === 'read',
				destructiveHint: t.tier === 'mutation',
			},
		})),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const tool = tools.find((t) => t.name === req.params.name);
		if (!tool) {
			throw new McpError(
				ErrorCode.MethodNotFound,
				`Unknown tool: ${req.params.name}`,
			);
		}
		const callArgs: Record<string, unknown> = req.params.arguments ?? {};
		if (!Value.Check(tool.input, callArgs)) {
			const detail = Value.Errors(tool.input, callArgs)
				.map((e) => `${e.instancePath || '/'}: ${e.message}`)
				.join('; ');
			throw new McpError(
				ErrorCode.InvalidParams,
				`Invalid arguments for "${tool.name}": ${detail}`,
			);
		}

		// Resolve the company per call so a freshly-authenticated realm is picked
		// up, and a missing one is a self-correctable result, not a startup crash.
		const { data: realmId, error: realmError } = resolveRealm(deps.config);
		if (realmError !== null) {
			return { content: [{ type: 'text', text: realmError }], isError: true };
		}
		const ctx: ToolContext = {
			config: deps.config,
			realmId,
			dbPath: dbPath(deps.config.dataDir, realmId),
			openQb: createQbAccess({
				config: deps.config,
				realmId,
				store: deps.store,
				now: deps.now,
			}),
			store: deps.store,
			now: deps.now,
		};
		return toCallResult(await tool.run(ctx, callArgs));
	});

	return server;
}
