/**
 * `local-books mcp`: a stdio Model Context Protocol server that exposes the
 * read / refresh / write verbs over the local QuickBooks mirror to a foreign
 * host (Claude Code, Codex, Cursor, ...).
 *
 * This file is now only the stdio transport wiring. The tool table, the catalog
 * + call handlers, the read-only gate, and the two error channels all live in
 * `mcp-server.ts` (`buildBooksServer`), so the `daemon` verb's HTTP transport
 * exposes the exact same airlock with no second definition.
 *
 * stdout is the JSON-RPC channel, so this subcommand prints NOTHING to stdout
 * except protocol frames: no banners, no `console.log`, no progress. A single
 * stray byte would corrupt framing.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ParsedArgs } from '../cli.ts';
import { loadConfig } from '../config.ts';
import { buildBooksServer, createBooksServerDeps } from './mcp-server.ts';

export async function runMcpServer(args: ParsedArgs): Promise<number> {
	// Same precedence the other verbs use (CLI > env > config.json > defaults);
	// the host typically passes LOCAL_BOOKS_DIR / _TOKEN_FILE / _READ_ONLY / the
	// realm via the MCP client config's `env`.
	const config = loadConfig({
		dataDir: args.dataDir,
		environment: args.environment,
		realm: args.realm,
	});

	const server = buildBooksServer(createBooksServerDeps(config));

	// stdout carries JSON-RPC frames from here on. Block until the host
	// disconnects, then let bin.ts exit cleanly. A stdio server should exit on
	// stdin EOF, not only on SIGTERM, so an orphaned server (parent died without
	// signaling) does not hang; the transport watches only 'data', so wire EOF
	// here in addition to the protocol's own close.
	const transport = new StdioServerTransport();
	const closed = new Promise<void>((resolve) => {
		server.onclose = () => resolve();
		process.stdin.once('end', resolve);
		process.stdin.once('close', resolve);
	});
	await server.connect(transport);
	await closed;
	return 0;
}
