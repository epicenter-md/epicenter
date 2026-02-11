import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import yargs from 'yargs';
import { defineMutation, defineQuery } from '../shared/actions';
import { buildActionCommands } from './command-builder';

describe('CLI command registration', () => {
	test('registers flat action commands with yargs', () => {
		const actions = {
			ping: defineQuery({
				handler: () => 'pong',
			}),
			sync: defineMutation({
				handler: () => {},
			}),
		};

		const commands = buildActionCommands(actions);

		let cli = yargs().scriptName('test');
		for (const cmd of commands) {
			cli = cli.command(cmd);
		}

		const commandInstance = cli.getInternalMethods().getCommandInstance();
		const registeredCommands = commandInstance.getCommands();

		expect(registeredCommands).toContain('ping');
		expect(registeredCommands).toContain('sync');
	});

	test('registers nested commands with top-level parent', () => {
		const actions = {
			posts: {
				list: defineQuery({
					handler: () => [],
				}),
			},
		};

		const commands = buildActionCommands(actions);

		let cli = yargs().scriptName('test');
		for (const cmd of commands) {
			cli = cli.command(cmd);
		}

		const commandInstance = cli.getInternalMethods().getCommandInstance();
		const registeredCommands = commandInstance.getCommands();

		expect(registeredCommands).toContain('posts');
	});

	test('command handlers are accessible', () => {
		const actions = {
			ping: defineQuery({
				handler: () => 'pong',
			}),
		};

		const commands = buildActionCommands(actions);

		let cli = yargs().scriptName('test');
		for (const cmd of commands) {
			cli = cli.command(cmd);
		}

		const commandInstance = cli.getInternalMethods().getCommandInstance();
		const handlers = commandInstance.getCommandHandlers();

		expect(handlers).toHaveProperty('ping');
		expect(typeof handlers.ping?.handler).toBe('function');
	});

	test('parses flat command options correctly', async () => {
		let capturedArgs: Record<string, unknown> | null = null;

		const actions = {
			create: defineMutation({
				input: type({ title: 'string', 'count?': 'number' }),
				handler: ({ title, count }) => {
					capturedArgs = { title, count };
					return { id: '1', title };
				},
			}),
		};

		const commands = buildActionCommands(actions);

		let cli = yargs()
			.scriptName('test')
			.fail(() => {});
		for (const cmd of commands) {
			cli = cli.command(cmd);
		}

		await cli.parseAsync(['create', '--title', 'Hello', '--count', '42']);

		expect(capturedArgs).not.toBeNull();
		expect(capturedArgs?.title).toBe('Hello');
		expect(capturedArgs?.count).toBe(42);
	});

	test('buildActionCommands returns correct command paths', () => {
		const actions = {
			ping: defineQuery({ handler: () => 'pong' }),
			posts: {
				list: defineQuery({ handler: () => [] }),
				create: defineMutation({
					input: type({ title: 'string' }),
					handler: ({ title }) => ({ title }),
				}),
			},
		};

		const commands = buildActionCommands(actions);
		const commandPaths = commands.map((c) => c.command);

		expect(commandPaths).toContain('ping');
		expect(commandPaths).toContain('posts list');
		expect(commandPaths).toContain('posts create');
	});
});
