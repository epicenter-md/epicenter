import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import yargs from 'yargs';
import { standardSchemaToYargs } from './standardschema-to-yargs';

describe('standardSchemaToYargs', () => {
	test('returns yargs unchanged when schema is undefined', async () => {
		const cli = yargs([]);
		const result = await standardSchemaToYargs(undefined, cli);
		expect(result).toBe(cli);
	});

	test('converts simple string field', async () => {
		const schema = type({ name: 'string' });
		const cli = yargs([]);
		const result = await standardSchemaToYargs(schema, cli);

		// Verify the option was added by checking internal state
		const options = (result as any).getOptions();
		expect(options.string).toContain('name');
	});

	test('converts optional string field', async () => {
		const schema = type({ name: 'string?' });
		const cli = yargs([]);
		const result = await standardSchemaToYargs(schema, cli);

		const options = (result as any).getOptions();
		expect(options.string).toContain('name');
		// Optional fields should not be in demandedOptions (it's an object with keys)
		expect(Object.keys(options.demandedOptions)).not.toContain('name');
	});

	test('converts required string field', async () => {
		const schema = type({ name: 'string' });
		const cli = yargs([]);
		await standardSchemaToYargs(schema, cli);

		const options = (cli as any).getOptions();
		// Required fields should be in demandedOptions
		expect(Object.keys(options.demandedOptions)).toContain('name');
	});

	test('converts number field', async () => {
		const schema = type({ age: 'number' });
		const cli = yargs([]);
		const result = await standardSchemaToYargs(schema, cli);

		const options = (result as any).getOptions();
		expect(options.number).toContain('age');
	});

	test('converts boolean field', async () => {
		const schema = type({ active: 'boolean' });
		const cli = yargs([]);
		const result = await standardSchemaToYargs(schema, cli);

		const options = (result as any).getOptions();
		expect(options.boolean).toContain('active');
	});

	test('converts string union as enum choices', async () => {
		const schema = type({ role: "'admin' | 'user' | 'guest'" });
		const cli = yargs([]);
		const result = await standardSchemaToYargs(schema, cli);

		const options = (result as any).getOptions();
		expect(options.string).toContain('role');
		// Order doesn't matter, just check all choices are present
		expect(options.choices.role).toEqual(
			expect.arrayContaining(['admin', 'user', 'guest']),
		);
		expect(options.choices.role.length).toBe(3);
	});

	test('converts multiple fields', async () => {
		const schema = type({
			name: 'string',
			age: 'number',
			active: 'boolean?',
		});
		const cli = yargs([]);
		const result = await standardSchemaToYargs(schema, cli);

		const options = (result as any).getOptions();
		expect(options.string).toContain('name');
		expect(options.number).toContain('age');
		expect(options.boolean).toContain('active');
	});

	test('handles complex schema with unions and optional fields', async () => {
		const schema = type({
			title: 'string',
			category: "'tech' | 'personal' | 'tutorial'",
			content: 'string?',
			views: 'number?',
		});
		const cli = yargs([]);
		const result = await standardSchemaToYargs(schema, cli);

		const options = (result as any).getOptions();
		expect(options.string).toContain('title');
		expect(options.string).toContain('category');
		expect(options.string).toContain('content');
		expect(options.number).toContain('views');
		// Order doesn't matter, just check all choices are present
		expect(options.choices.category).toEqual(
			expect.arrayContaining(['tech', 'personal', 'tutorial']),
		);
		expect(options.choices.category.length).toBe(3);
	});

	test('can parse actual CLI arguments with converted schema', async () => {
		const schema = type({
			name: 'string',
			count: 'number',
		});
		const cli = yargs([]);
		await standardSchemaToYargs(schema, cli);

		const result = await cli.parse(['--name', 'test', '--count', '42']);
		expect(result.name).toBe('test');
		expect(result.count).toBe(42);
	});

	test('validates enum choices at runtime', async () => {
		const schema = type({ role: "'admin' | 'user'" });
		const cli = yargs([]);
		await standardSchemaToYargs(schema, cli);

		// Valid choice should work
		const validResult = await cli.parse(['--role', 'admin']);
		expect(validResult.role).toBe('admin');

		// Invalid choice should fail
		const invalidCli = yargs([]);
		await standardSchemaToYargs(schema, invalidCli);
		invalidCli.exitProcess(false); // Prevent process exit in tests

		try {
			await invalidCli.parse(['--role', 'invalid']);
			expect(false).toBe(true); // Should not reach here
		} catch (error) {
			// Expected to fail validation
			expect(error).toBeDefined();
		}
	});

	test('handles arrays', async () => {
		const schema = type({ tags: 'string[]' });
		const cli = yargs([]);
		const result = await standardSchemaToYargs(schema, cli);

		const options = (result as any).getOptions();
		expect(options.array).toContain('tags');

		// Test parsing array arguments
		const parsed = await cli.parse(['--tags', 'foo', '--tags', 'bar']);
		expect(parsed.tags).toEqual(['foo', 'bar']);
	});
});
