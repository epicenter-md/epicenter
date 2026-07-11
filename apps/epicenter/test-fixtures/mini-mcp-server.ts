/**
 * A tiny stdio MCP server standing in for `local-books mcp` in the host smoke
 * test, so the arm-B path is exercised without depending on the
 * `@epicenter/local-books` app, its config, or a mirror database. It exposes
 * one read-only `customers` tool mirroring the "who owes me money?" answer.
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
	],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
	if (req.params.name !== 'customers') {
		return {
			content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }],
			isError: true,
		};
	}
	return { content: [{ type: 'text', text: CUSTOMERS.join('\n') }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
