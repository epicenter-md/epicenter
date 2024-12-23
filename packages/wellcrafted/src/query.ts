import type { Result } from "./result";
import { Ok } from "./result";

export type QueryFn<I, O, ServiceErrorProperties> = (
	input: I,
) => Promise<Result<O, ServiceErrorProperties>>;

export function createMutation<I, O, ServiceError, TContext = undefined>({
	mutationFn,
	onMutate = () => Ok(undefined as TContext),
	onSuccess = () => undefined,
	onError = () => undefined,
	onSettled = () => undefined,
}: {
	mutationFn: (
		input: I,
		args: { context: TContext },
	) => Promise<Result<O, ServiceError>> | Result<O, ServiceError>;
	onMutate?: (
		input: I,
	) => Promise<Result<TContext, ServiceError>> | Result<TContext, ServiceError>;
	onSuccess?: (output: O, args: { input: I; context: TContext }) => void;
	onError?: (
		error: ServiceError,
		args: { input: I; contextResult: Result<TContext, ServiceError> },
	) => void;
	onSettled?: (
		result: Result<O, ServiceError>,
		args: { input: I; contextResult: Result<TContext, ServiceError> },
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
	return { mutate };
}
