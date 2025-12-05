import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import { Ok } from 'wellcrafted/result';
import { defineEpicenter } from '../core/epicenter';
import {
	defineMutation,
	defineWorkspace,
	id,
	sqliteIndex,
	text,
} from '../index';
import { createCLI } from './cli';

describe('CLI Integration', () => {
	const testWorkspace = defineWorkspace({
		id: 'test',

		schema: {
			items: {
				id: id(),
				name: text(),
				count: text(),
			},
		},

		indexes: {
			sqlite: (c) => sqliteIndex(c),
		},

		exports: ({ db }) => ({
			createItem: defineMutation({
				input: type({
					name: 'string',
					count: 'number',
				}),
				description: 'Create a new item',
				handler: async ({ name, count }) => {
					const item = {
						id: `item-${Date.now()}`,
						name,
						count: String(count),
					};
					db.items.insert(item);
					return Ok(item);
				},
			}),
		}),
	});

	const epicenter = defineEpicenter({
		id: 'test-cli-epicenter',
		workspaces: [testWorkspace],
	});

	test('CLI can be created from epicenter config', async () => {
		const cli = await createCLI({ config: epicenter, argv: [] });
		expect(cli).toBeDefined();
	});

	test('creates CLI with proper command structure', async () => {
		const cli = await createCLI({ config: epicenter, argv: [] });

		// Verify CLI has basic yargs structure
		expect(cli.parse).toBeDefined();
	});
});
