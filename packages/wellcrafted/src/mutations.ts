import type { Result } from "./result.js";
import { Ok, isErr } from "./result.js";

export function createMutation<
	I,
	O,
	MutationFnError = never,
	OnMutateError = never,
	TContext = undefined,
>({
	mutationFn,
	onMutate = () => Ok(undefined as TContext),
	onSuccess,
	onError,
	onSettled,
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
	const mutate = async (
		input: I,
		{
			onSuccess: onSuccessLocal,
			onError: onErrorLocal,
			onSettled: onSettledLocal,
		}: Partial<{
			onSuccess: (output: O, args: { input: I; context: TContext }) => void;
			onError: (
				error: MutationFnError | OnMutateError,
				args: {
					input: I;
					contextResult: Result<TContext, OnMutateError>;
				},
			) => void;
			onSettled: (
				result: Result<O, MutationFnError | OnMutateError>,
				args: { input: I; contextResult: Result<TContext, OnMutateError> },
			) => void;
		}> = {},
	): Promise<void> => {
		const contextResult = await onMutate(input);
		if (isErr(contextResult)) {
			const error = contextResult.error;
			onError?.(error, { input, contextResult });
			onErrorLocal?.(error, { input, contextResult });
			onSettled?.(contextResult, { input, contextResult });
			onSettledLocal?.(contextResult, { input, contextResult });
			return;
		}
		const context = contextResult.data;
		const result = await mutationFn(input, { context });
		if (isErr(result)) {
			const error = result.error;
			onError?.(error, { input, contextResult });
			onErrorLocal?.(error, { input, contextResult });
			onSettled?.(result, { input, contextResult });
			onSettledLocal?.(result, { input, contextResult });
			return;
		}
		const output = result.data;
		onSuccess?.(output, { input, context });
		onSuccessLocal?.(output, { input, context });
		onSettled?.(result, { input, contextResult });
		onSettledLocal?.(result, { input, contextResult });
	};
	return mutate;
}
