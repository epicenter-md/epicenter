import { openapi } from '@elysiajs/openapi';
import { Elysia } from 'elysia';
import type { AnyWorkspaceClient } from '../static/types';
import { collectActionPaths, createActionsRouter } from './actions';
import { createSyncPlugin } from './sync';
import { createTablesPlugin } from './tables';

export const DEFAULT_PORT = 3913;

export type ServerOptions = {
	port?: number;
};

/**
 * Create an HTTP server that exposes workspace clients as REST APIs and WebSocket sync.
 *
 * The server provides:
 * - `/` - API root with discovery info
 * - `/openapi` - Interactive API documentation (Scalar UI)
 * - `/openapi/json` - OpenAPI specification
 * - `/workspaces/{id}/tables/{table}` - RESTful table CRUD endpoints
 * - `/workspaces/{id}/sync` - WebSocket sync endpoint (y-websocket protocol)
 *
 * @example
 * ```typescript
 * import { createWorkspace } from '@epicenter/hq/static';
 *
 * const workspace = createWorkspace(definition).withExtensions({ ... });
 *
 * const server = createServer(workspace, { port: 3913 });
 * server.start();
 *
 * // Access endpoints:
 * // GET  http://localhost:3913/workspaces/blog/tables/posts
 * // POST http://localhost:3913/workspaces/blog/tables/posts
 * // WS   ws://localhost:3913/workspaces/blog/sync
 * ```
 */
function createServer(
	client: AnyWorkspaceClient,
	options?: ServerOptions,
): ReturnType<typeof createServerInternal>;
function createServer(
	clients: AnyWorkspaceClient[],
	options?: ServerOptions,
): ReturnType<typeof createServerInternal>;
function createServer(
	clientOrClients: AnyWorkspaceClient | AnyWorkspaceClient[],
	options?: ServerOptions,
): ReturnType<typeof createServerInternal> {
	const clients = Array.isArray(clientOrClients)
		? clientOrClients
		: [clientOrClients];
	return createServerInternal(clients, options);
}

function createServerInternal(
	clients: AnyWorkspaceClient[],
	options?: ServerOptions,
) {
	const workspaces: Record<string, AnyWorkspaceClient> = {};

	for (const client of clients) {
		workspaces[client.id] = client;
	}

	// Read actions from the first client
	const firstClient = clients[0];
	const actions = firstClient?.actions;
	const actionPaths = actions ? collectActionPaths(actions) : [];

	const baseApp = new Elysia()
		.use(
			openapi({
				embedSpec: true,
				documentation: {
					info: {
						title: 'Epicenter API',
						version: '1.0.0',
						description: 'API documentation for Epicenter workspaces',
					},
				},
			}),
		)
		.use(
			createSyncPlugin({
				getDoc: (room) => workspaces[room]?.ydoc,
			}),
		)
		.use(createTablesPlugin(workspaces));

	const appWithActions = actions
		? baseApp.use(createActionsRouter({ client: firstClient, actions }))
		: baseApp;

	const app = appWithActions.get('/', () => ({
		name: 'Epicenter API',
		version: '1.0.0',
		docs: '/openapi',
		workspaces: Object.keys(workspaces),
		actions: actionPaths,
	}));

	const port =
		options?.port ??
		Number.parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);

	return {
		app,

		start() {
			console.log('Creating HTTP server...');

			const server = Bun.serve({
				fetch: app.fetch,
				port,
			});

			console.log('\nEpicenter HTTP Server Running!\n');
			console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
			console.log(`Server: http://localhost:${port}`);
			console.log(`API Docs: http://localhost:${port}/openapi`);
			console.log(`OpenAPI Spec: http://localhost:${port}/openapi/json\n`);

			console.log('Available Workspaces:\n');
			for (const [workspaceId, client] of Object.entries(workspaces)) {
				console.log(`  ${workspaceId}`);
				for (const tableName of Object.keys(client.definitions.tables)) {
					console.log(`    tables/${tableName}`);
				}
				console.log(`    sync (WebSocket)`);
				console.log();
			}

			if (actionPaths.length > 0) {
				console.log('Available Actions:\n');
				for (const actionPath of actionPaths) {
					console.log(`  /actions/${actionPath}`);
				}
				console.log();
			}

			console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
			console.log('Server is running. Press Ctrl+C to stop.\n');

			let isShuttingDown = false;

			const shutdown = async (signal: string) => {
				if (isShuttingDown) return;
				isShuttingDown = true;

				console.log(`\nReceived ${signal}, shutting down...`);

				server.stop();
				await Promise.all(clients.map((c) => c.destroy()));

				console.log('Server stopped cleanly\n');
				process.exit(0);
			};

			process.on('SIGINT', () => shutdown('SIGINT'));
			process.on('SIGTERM', () => shutdown('SIGTERM'));

			return server;
		},

		async destroy() {
			await Promise.all(clients.map((c) => c.destroy()));
		},
	};
}

export { createServer };
