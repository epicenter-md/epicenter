import { Elysia } from 'elysia';
import type { AnyWorkspaceClient, TableHelper } from '../static/types';

export function createTablesPlugin(
	workspaceClients: Record<string, AnyWorkspaceClient>,
) {
	const app = new Elysia();

	for (const [workspaceId, workspace] of Object.entries(workspaceClients)) {
		for (const [tableName, value] of Object.entries(workspace.tables)) {
			const tableHelper = value as TableHelper<{ id: string }>;

			const basePath = `/workspaces/${workspaceId}/tables/${tableName}`;
			const tags = [workspaceId, 'tables'];

			app.get(basePath, () => tableHelper.getAllValid(), {
				detail: { description: `List all ${tableName}`, tags },
			});

			app.get(
				`${basePath}/:id`,
				({ params, status }) => {
					const result = tableHelper.get(params.id);
					if (result.status === 'not_found')
						return status('Internal Server Error', result);
					if (result.status === 'invalid')
						return status('Unprocessable Content', result);
					return result;
				},
				{
					detail: { description: `Get ${tableName} by ID`, tags },
				},
			);

			app.put(
				`${basePath}/:id`,
				({ params, body, status }) => {
					const result = tableHelper.parse(params.id, body);
					if (result.status === 'invalid')
						return status('Unprocessable Content', result);
					tableHelper.set(result.row);
					return result;
				},
				{
					detail: { description: `Create or replace ${tableName} by ID`, tags },
				},
			);

			app.patch(
				`${basePath}/:id`,
				({ params, body, status }) => {
					const result = tableHelper.update(
						params.id,
						body as Record<string, unknown>,
					);
					if (result.status === 'not_found') return status(404, result);
					if (result.status === 'invalid')
						return status('Unprocessable Content', result);
					return result;
				},
				{
					detail: { description: `Partial update ${tableName} by ID`, tags },
				},
			);

			app.delete(
				`${basePath}/:id`,
				({ params }) => tableHelper.delete(params.id),
				{
					detail: { description: `Delete ${tableName} by ID`, tags },
				},
			);
		}
	}

	return app;
}
