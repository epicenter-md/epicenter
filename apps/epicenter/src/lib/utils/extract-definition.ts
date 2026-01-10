import type { WorkspaceDefinition } from '@epicenter/hq';
import * as Y from 'yjs';

/**
 * Extract workspace definition from an already-loaded Y.Doc.
 *
 * This is a pure function with no I/O - it reads directly from the Y.Doc's
 * in-memory state. Use this after persistence has finished loading from disk.
 *
 * @example
 * ```typescript
 * const client = workspace.create({ epoch, capabilities: { persistence } });
 * await client.whenSynced; // persistence has loaded existing data
 * const definition = extractDefinitionFromYDoc(client.ydoc, workspaceId);
 * ```
 */
export function extractDefinitionFromYDoc(
	ydoc: Y.Doc,
	workspaceId: string,
): WorkspaceDefinition {
	const metaMap = ydoc.getMap<string>('meta');
	const schemaMap = ydoc.getMap('schema');

	const tablesYMap = schemaMap.get('tables') as
		| Y.Map<Y.Map<unknown>>
		| undefined;
	const tables: WorkspaceDefinition['tables'] = {};

	if (tablesYMap) {
		for (const [tableName, tableMap] of tablesYMap.entries()) {
			const fieldsMap = tableMap.get('fields') as Y.Map<unknown> | undefined;
			const fields: Record<string, unknown> = {};
			if (fieldsMap) {
				for (const [fieldName, fieldDef] of fieldsMap.entries()) {
					fields[fieldName] = fieldDef;
				}
			}
			tables[tableName] = {
				name: (tableMap.get('name') as string) ?? tableName,
				icon:
					(tableMap.get(
						'icon',
					) as WorkspaceDefinition['tables'][string]['icon']) ?? null,
				cover:
					(tableMap.get(
						'cover',
					) as WorkspaceDefinition['tables'][string]['cover']) ?? null,
				description: (tableMap.get('description') as string) ?? '',
				fields: fields as WorkspaceDefinition['tables'][string]['fields'],
			};
		}
	}

	const kvYMap = schemaMap.get('kv') as Y.Map<unknown> | undefined;
	const kv: WorkspaceDefinition['kv'] = {};
	if (kvYMap) {
		for (const [key, value] of kvYMap.entries()) {
			kv[key] = value as WorkspaceDefinition['kv'][string];
		}
	}

	return {
		id: workspaceId,
		slug: metaMap.get('slug') ?? workspaceId,
		name: metaMap.get('name') ?? 'Untitled',
		tables,
		kv,
	};
}
