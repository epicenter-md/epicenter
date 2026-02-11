import type { CommandModule } from 'yargs';
import type { Actions } from '../shared/actions';
import { iterateActions } from '../shared/actions';
import { standardSchemaToJsonSchema } from '../shared/standard-schema/to-json-schema';
import { jsonSchemaToYargsOptions } from './json-schema-to-yargs';

/**
 * Build yargs command configurations from an actions tree.
 *
 * Iterates over all action definitions and creates CommandModule configs that can be
 * registered with yargs. Separates the concern of building command configs
 * from registering them, enabling cleaner CLI construction.
 *
 * @remarks
 * Actions use closure-based dependency injection - they capture their context
 * (tables, extensions, etc.) at definition time. The handler is called directly
 * with just the validated input.
 *
 * @example
 * ```typescript
 * const client = createWorkspace({ ... });
 * const actions = {
 *   posts: {
 *     getAll: defineQuery({ handler: () => client.tables.posts.getAllValid() }),
 *   },
 * };
 * const commands = buildActionCommands(actions);
 * for (const cmd of commands) {
 *   cli = cli.command(cmd);
 * }
 * ```
 */
export function buildActionCommands(actions: Actions): CommandModule[] {
	return [...iterateActions(actions)].map(([action, path]) => {
		const commandPath = path.join(' ');
		const description =
			action.description ??
			`${action.type === 'query' ? 'Query' : 'Mutation'}: ${path.join('.')}`;

		const jsonSchema = action.input
			? (standardSchemaToJsonSchema(action.input) as Record<string, unknown>)
			: undefined;

		const builder = jsonSchema ? jsonSchemaToYargsOptions(jsonSchema) : {};

		return {
			command: commandPath,
			describe: description,
			builder,
			handler: async (argv: Record<string, unknown>) => {
				const input = extractInputFromArgv(argv, jsonSchema);
				let validatedInput: unknown;

				if (action.input) {
					const result = await action.input['~standard'].validate(input);
					if (result.issues) {
						console.error('Validation failed:');
						for (const issue of result.issues) {
							console.error(
								`  - ${issue.path?.join('.') ?? 'input'}: ${issue.message}`,
							);
						}
						process.exit(1);
					}
					validatedInput = result.value;
				}

				const output = action.input
					? await action.handler(validatedInput)
					: await (action.handler as () => unknown)();
				console.log(JSON.stringify(output, null, 2));
			},
		};
	});
}

function extractInputFromArgv(
	argv: Record<string, unknown>,
	jsonSchema: Record<string, unknown> | undefined,
): Record<string, unknown> {
	if (!jsonSchema || jsonSchema.type !== 'object' || !jsonSchema.properties) {
		return {};
	}

	const properties = jsonSchema.properties as Record<string, unknown>;
	const input: Record<string, unknown> = {};

	for (const key of Object.keys(properties)) {
		if (key in argv && argv[key] !== undefined) {
			input[key] = argv[key];
		}
	}

	return input;
}
