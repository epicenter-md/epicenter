import type { Result } from "./result";
import { Ok } from "./result";

export type QueryFn<I, O, ServiceErrorProperties> = (
	input: I,
) => Promise<Result<O, ServiceErrorProperties>>;

export function createMutation<I, O, ServiceError, TContext>({
	mutationFn,
	onMutate = () => Ok({} as TContext),
	onSuccess = () => undefined,
	onError = () => undefined,
	onSettled = () => undefined,
}: {
	mutationFn: (args: { input: I; context: TContext }) =>
		| Promise<Result<O, ServiceError>>
		| Result<O, ServiceError>;
	onMutate?: (
		input: I,
	) => Promise<Result<TContext, ServiceError>> | Result<TContext, ServiceError>;
	onSuccess?: (args: { output: O; input: I; context: TContext }) => void;
	onError?: (args: {
		error: ServiceError;
		input: I;
		contextResult: Result<TContext, ServiceError>;
	}) => void;
	onSettled?: (args: {
		result: Result<O, ServiceError>;
		input: I;
		contextResult: Result<TContext, ServiceError>;
	}) => void;
}) {
	const mutate = async (input: I): Promise<void> => {
		const contextResult = await onMutate(input);
		if (!contextResult.ok) {
			const error = contextResult.error;
			onError({ error, input, contextResult });
			onSettled({ result: contextResult, input, contextResult });
			return;
		}
		const context = contextResult.data;
		const result = await mutationFn({ input, context });
		if (!result.ok) {
			const error = result.error;
			onError({ error, input, contextResult });
			onSettled({ result, input, contextResult });
			return;
		}
		const output = result.data;
		onSuccess({ output, input, context });
		onSettled({ result, input, contextResult });
	};
	return { mutate };
}
