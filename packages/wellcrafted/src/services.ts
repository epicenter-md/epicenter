import type { Result } from "./result";
import { Err, Ok, tryAsync, trySync } from "./result";

type ServiceResultFactoryFns<ErrProps extends Record<string, unknown>> = {
	Ok: <T>(data: T) => Ok<T>;
	Err: <Props extends ErrProps>(props: Props) => Err<Props>;
	trySync: <T>(opts: {
		try: () => T extends Promise<unknown> ? never : T;
		catch: (error: unknown) => ErrProps;
	}) => Result<T, ErrProps>;
	tryAsync: <T>(opts: {
		try: () => Promise<T>;
		catch: (error: unknown) => ErrProps;
	}) => Promise<Result<T, ErrProps>>;
};

export const createServiceResultFactoryFns = <
	ErrorProps extends Record<string, unknown>,
>(): ServiceResultFactoryFns<ErrorProps> => ({
	Ok,
	Err,
	trySync,
	tryAsync,
});

export type QueryFn<I, O, ServiceError> = (
	input: I,
) => Promise<Result<O, ServiceError>>;

export type MutationFn<I, O, ServiceError> = (
	input: I,
	callbacks: {
		onMutate: (data: O) => void;
		onSuccess: () => void;
		onError: (error: ServiceError) => void;
		onSettled: () => void;
	},
) => Promise<void>;
