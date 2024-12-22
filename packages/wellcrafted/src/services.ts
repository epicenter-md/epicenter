import type { Result } from "./result";
import { Err, Ok, tryAsync, trySync } from "./result";

type ServiceResultFactoryFns<ErrProperties extends Record<string, unknown>> = {
	Ok: typeof Ok;
	Err: (props: ErrProperties) => Err<ErrProperties>;
	trySync: <T>(opts: {
		try: () => T extends Promise<unknown> ? never : T;
		catch: (error: unknown) => ErrProperties;
	}) => Result<T, ErrProperties>;
	tryAsync: <T>(opts: {
		try: () => Promise<T>;
		catch: (error: unknown) => ErrProperties;
	}) => Promise<Result<T, ErrProperties>>;
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
