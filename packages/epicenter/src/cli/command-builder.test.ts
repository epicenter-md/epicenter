import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import { defineMutation, defineQuery } from '../shared/actions';
import { buildActionCommands } from './command-builder';

describe('buildActionCommands', () => {
	test('builds command from simple action without input', () => {
		const actions = {
			getAll: defineQuery({
				handler: () => [],
			}),
		};

		const commands = buildActionCommands(actions);

		expect(commands).toHaveLength(1);
		expect(commands[0]?.command).toBe('getAll');
		expect(commands[0]?.describe).toBe('Query: getAll');
		expect(commands[0]?.builder).toEqual({});
		expect(typeof commands[0]?.handler).toBe('function');
	});

	test('builds command from action with input schema', () => {
		const actions = {
			create: defineMutation({
				input: type({ title: 'string' }),
				handler: ({ title }) => ({ id: '1', title }),
			}),
		};

		const commands = buildActionCommands(actions);

		expect(commands).toHaveLength(1);
		expect(commands[0]?.command).toBe('create');
		expect(commands[0]?.describe).toBe('Mutation: create');
		expect(commands[0]?.builder).toHaveProperty('title');
	});

	test('builds commands from nested actions', () => {
		const actions = {
			posts: {
				getAll: defineQuery({
					handler: () => [],
				}),
				create: defineMutation({
					input: type({ title: 'string' }),
					handler: ({ title }) => ({ id: '1', title }),
				}),
			},
		};

		const commands = buildActionCommands(actions);

		expect(commands).toHaveLength(2);

		const commandNames = commands.map((c) => c.command);
		expect(commandNames).toContain('posts getAll');
		expect(commandNames).toContain('posts create');
	});

	test('builds commands from deeply nested actions', () => {
		const actions = {
			api: {
				v1: {
					posts: {
						list: defineQuery({
							handler: () => [],
						}),
					},
				},
			},
		};

		const commands = buildActionCommands(actions);

		expect(commands).toHaveLength(1);
		expect(commands[0]?.command).toBe('api v1 posts list');
	});

	test('uses description from action when provided', () => {
		const actions = {
			sync: defineMutation({
				description: 'Sync data from external source',
				handler: () => {},
			}),
		};

		const commands = buildActionCommands(actions);

		expect(commands[0]?.describe).toBe('Sync data from external source');
	});

	test('builder contains yargs options for input schema', () => {
		const actions = {
			create: defineMutation({
				input: type({
					title: 'string',
					'count?': 'number',
				}),
				handler: ({ title }) => ({ id: '1', title }),
			}),
		};

		const commands = buildActionCommands(actions);
		const builder = commands[0]?.builder as Record<string, unknown>;

		expect(builder).toHaveProperty('title');
		expect(builder).toHaveProperty('count');
	});

	test('returns empty array for empty actions', () => {
		const commands = buildActionCommands({});
		expect(commands).toEqual([]);
	});

	test('handles mixed flat and nested actions', () => {
		const actions = {
			ping: defineQuery({
				handler: () => 'pong',
			}),
			users: {
				list: defineQuery({
					handler: () => [],
				}),
			},
		};

		const commands = buildActionCommands(actions);

		expect(commands).toHaveLength(2);
		const commandNames = commands.map((c) => c.command);
		expect(commandNames).toContain('ping');
		expect(commandNames).toContain('users list');
	});
});
