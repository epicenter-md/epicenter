/**
 * A tiny stdio MCP server standing in for `local-books mcp` in the host smoke
 * test, so the arm-B path is exercised without depending on the
 * `@epicenter/local-books` app, its config, or a mirror database.
 *
 * Two tools, one of each kind: a read-only `customers` mirroring the "who owes
 * me money?" answer, and a `write_off` that mutates. The host projects the
 * read-only hint to `query` and everything else to `mutation`, so the pair is
 * what lets the approval-gate tests reach both sides of that policy.
 *
 * stdout is the JSON-RPC channel: nothing else may print to it.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const CUSTOMERS = ['Acme | 4200.00', 'Globex | 1500.00', 'Initech | 300.00'];

const server = new Server(
	{ name: 'mini-books', version: '0.0.0' },
	{ capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			name: 'customers',
			title: 'List customers',
			description: 'Who owes money, by balance.',
			inputSchema: { type: 'object', properties: {} },
			annotations: { readOnlyHint: true },
		},
		{
			name: 'write_off',
			title: 'Write off a balance',
			description: "Forgive one customer's outstanding balance.",
			inputSchema: {
				type: 'object',
				properties: { name: { type: 'string' } },
			},
		},
	],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
	if (req.params.name === 'customers') {
		return { content: [{ type: 'text', text: CUSTOMERS.join('\n') }] };
	}
	if (req.params.name === 'write_off') {
		const name = (req.params.arguments as { name?: string } | undefined)?.name;
		return {
			content: [{ type: 'text', text: `Wrote off ${name ?? 'nobody'}` }],
		};
	}
	return {
		content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }],
		isError: true,
	};
});

const transport = new StdioServerTransport();
await server.connect(transport);
