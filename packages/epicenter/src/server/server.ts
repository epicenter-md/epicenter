import { StreamableHTTPTransport } from '@hono/mcp';
import { swaggerUI } from '@hono/swagger-ui';
import { Scalar } from '@scalar/hono-api-reference';
import { Hono } from 'hono';
import { describeRoute, openAPIRouteHandler, validator } from 'hono-openapi';
import { Err, isResult, Ok } from 'wellcrafted/result';
import {
	createEpicenterClient,
	type EpicenterClient,
	type EpicenterConfig,
	iterActions,
} from '../core/epicenter';
import { ARKTYPE_JSON_SCHEMA_FALLBACK } from '../core/schema/arktype-fallback';
import type { AnyWorkspaceConfig } from '../core/workspace';
import { createMcpServer } from './mcp';

/** hono-openapi validator options with arktype fallback handlers */
const HONO_OPENAPI_ARKTYPE_OPTIONS = {
	options: { fallback: ARKTYPE_JSON_SCHEMA_FALLBACK },
};

/**
 * Create a unified server with REST, MCP, and API documentation endpoints
 *
 * This creates a Hono server that exposes workspace actions through multiple interfaces:
 * - REST endpoints: GET `/{workspace}/{action}` for queries, POST for mutations
 * - MCP endpoint: POST `/mcp` for Model Context Protocol clients (using Server-Sent Events)
 * - API documentation: `/swagger-ui` (Swagger UI) and `/scalar` (Scalar)
 * - OpenAPI spec: `/openapi.json`
 *
 * The function initializes the Epicenter client, registers REST routes for all workspace actions,
 * and configures an MCP server instance for protocol-based access.
 *
 * @param config - Epicenter configuration with workspaces
 * @returns Object containing the Hono app and Epicenter client
 *
 * @see {@link createMcpServer} in mcp.ts for the MCP server implementation
 *
 * @example
 * ```typescript
 * import { defineEpicenter } from '@epicenter/core';
 * import { createServer } from '@epicenter/core/server';
 * import { blogWorkspace } from './workspaces/blog';
 *
 * const epicenter = defineEpicenter({
 *   id: 'my-app',
 *   workspaces: [blogWorkspace],
 * });
 *
 * const { app, client } = await createServer(epicenter);
 *
 * Bun.serve({
 *   fetch: app.fetch,
 *   port: 3913,
 * });
 *
 * // Access at:
 * // - http://localhost:3913/swagger-ui (Swagger UI)
 * // - http://localhost:3913/scalar (Scalar)
 * ```
 */
export async function createServer<
	TId extends string,
	TWorkspaces extends readonly AnyWorkspaceConfig[],
>(
	config: EpicenterConfig<TId, TWorkspaces>,
): Promise<{
	/** Hono web server instance */
	app: Hono;
	/** Epicenter client with initialized workspaces and actions */
	client: EpicenterClient<TWorkspaces>;
}> {
	const app = new Hono();

	// Create client
	const client = await createEpicenterClient(config);

	// Register REST endpoints for each workspace action
	// Supports nested exports: actionPath like ['users', 'crud', 'create']
	// becomes route path '/workspace/users/crud/create'
	for (const { workspaceId, actionPath, action } of iterActions(client)) {
		const path = `/${workspaceId}/${actionPath.join('/')}`;

		// Tag with both workspace and operation type for multi-dimensional grouping
		const operationType = (
			{ query: 'queries', mutation: 'mutations' } as const
		)[action.type];
		const tags = [workspaceId, operationType];

		switch (action.type) {
			case 'query':
				// Queries use GET with query parameters
				app.get(
					path,
					describeRoute({
						description: action.description,
						tags,
					}),
					...(action.input
						? [
								validator(
									'query',
									action.input,
									undefined,
									HONO_OPENAPI_ARKTYPE_OPTIONS,
								),
							]
						: []),
					async (c) => {
						// Get validated input from middleware (if schema exists)
						const input = action.input ? c.req.valid('query') : undefined;

						// Execute action - input already validated by middleware
						const result = await action(input);

						// Handle both Result types and raw values
						if (isResult(result)) {
							const { data, error } = result;
							if (error) return c.json(Err(error), 500);
							return c.json(Ok(data));
						}

						// Raw value from handler that can't fail
						return c.json(result);
					},
				);
				break;
			case 'mutation':
				// Mutations use POST with JSON body
				app.post(
					path,
					describeRoute({
						description: action.description,
						tags,
					}),
					...(action.input
						? [
								validator(
									'json',
									action.input,
									undefined,
									HONO_OPENAPI_ARKTYPE_OPTIONS,
								),
							]
						: []),
					async (c) => {
						// Get validated input from middleware (if schema exists)
						const input = action.input ? c.req.valid('json') : undefined;

						// Execute action - input already validated by middleware
						const result = await action(input);

						// Handle both Result types and raw values
						if (isResult(result)) {
							const { data, error } = result;
							if (error) return c.json(Err(error), 500);
							return c.json(Ok(data));
						}

						// Raw value from handler that can't fail
						return c.json(result);
					},
				);
				break;
		}
	}

	// Create and configure MCP server for /mcp endpoint
	const mcpServer = await createMcpServer(client, config);

	// Initialize transport once (per @hono/mcp docs, transport should be reused)
	const transport = new StreamableHTTPTransport();

	// Register MCP endpoint using StreamableHTTPTransport
	app.all('/mcp', async (c) => {
		// Only connect if not already connected (connection persists across requests)
		// Server.transport is set when connect() is called
		if (mcpServer.transport === undefined) {
			await mcpServer.connect(transport);
		}
		return transport.handleRequest(c);
	});

	// OpenAPI specification endpoint
	app.get(
		'/openapi.json',
		openAPIRouteHandler(app, {
			excludeStaticFile: false,
			documentation: {
				info: {
					title: `${config.id} API`,
					version: '1.0.0',
					description: 'API documentation for Epicenter workspaces',
				},
			},
		}),
	);

	// Swagger UI endpoint
	app.get('/swagger-ui', swaggerUI({ url: '/openapi.json' }));

	// Scalar UI endpoint
	app.get('/scalar', Scalar({ url: '/openapi.json' }));

	return { app, client };
}
