import type { Result } from "./result";
import { Ok } from "./result";

export function createMutation<
	I,
	O,
	MutationFnError,
	OnMutateError,
	TContext = undefined,
>({
	mutationFn,
	onMutate = () => Ok(undefined as TContext),
	onSuccess = () => undefined,
	onError = () => undefined,
	onSettled = () => undefined,
}: {
	mutationFn: (
		input: I,
		args: { context: TContext },
	) => Promise<Result<O, MutationFnError>> | Result<O, MutationFnError>;
	onMutate?: (
		input: I,
	) =>
		| Promise<Result<TContext, OnMutateError>>
		| Result<TContext, OnMutateError>;
	onSuccess?: (output: O, args: { input: I; context: TContext }) => void;
	onError?: (
		error: MutationFnError | OnMutateError,
		args: {
			input: I;
			contextResult: Result<TContext, OnMutateError>;
		},
	) => void;
	onSettled?: (
		result: Result<O, MutationFnError | OnMutateError>,
		args: { input: I; contextResult: Result<TContext, OnMutateError> },
	) => void;
}) {
	const mutate = async (input: I): Promise<void> => {
		const contextResult = await onMutate(input);
		if (!contextResult.ok) {
			const error = contextResult.error;
			onError(error, { input, contextResult });
			onSettled(contextResult, { input, contextResult });
			return;
		}
		const context = contextResult.data;
		const result = await mutationFn(input, { context });
		if (!result.ok) {
			const error = result.error;
			onError(error, { input, contextResult });
			onSettled(result, { input, contextResult });
			return;
		}
		const output = result.data;
		onSuccess(output, { input, context });
		onSettled(result, { input, contextResult });
	};
	return mutate;
}
