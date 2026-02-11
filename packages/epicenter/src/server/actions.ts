import { Elysia } from 'elysia';
import type { Actions } from '../shared/actions';
import { iterateActions } from '../shared/actions';

type ActionsRouterOptions = {
	client: unknown;
	actions: Actions;
	basePath?: string;
};

/**
 * Create an Elysia router for action definitions.
 *
 * @remarks
 * Actions are closure-based - they capture their dependencies (tables, extensions, etc.)
 * at definition time. The router invokes handlers directly.
 */
export function createActionsRouter(options: ActionsRouterOptions) {
	const { actions, basePath = '/actions' } = options;
	const router = new Elysia({ prefix: basePath });

	for (const [action, path] of iterateActions(actions)) {
		const routePath = `/${path.join('/')}`;
		const namespaceTags = path.length > 1 ? [path[0] as string] : [];
		const tags = [...namespaceTags, action.type];

		const detail = {
			summary: path.join('.'),
			description: action.description,
			tags,
		};

		const handleRequest = async (input: unknown) => {
			let validatedInput: unknown;
			if (action.input) {
				const result = await action.input['~standard'].validate(input);
				if (result.issues) {
					return {
						error: { message: 'Validation failed', issues: result.issues },
					};
				}
				validatedInput = result.value;
				// Call handler with validated input
				const output = await action.handler(validatedInput);
				return { data: output };
			}
			// Call handler with no arguments for actions without input
			const output = await (action.handler as () => unknown)();
			return { data: output };
		};

		switch (action.type) {
			case 'query':
				router.get(routePath, ({ query }) => handleRequest(query), {
					query: action.input,
					detail,
				});
				break;
			case 'mutation':
				router.post(routePath, ({ body }) => handleRequest(body), {
					body: action.input,
					detail,
				});
				break;
			default: {
				const _exhaustive: never = action;
				throw new Error(
					`Unknown action type: ${(_exhaustive as { type: string }).type}`,
				);
			}
		}
	}

	return router;
}

/**
 * Collect action paths for logging/discovery.
 */
export function collectActionPaths(actions: Actions): string[] {
	return [...iterateActions(actions)].map(([, path]) => path.join('/'));
}
