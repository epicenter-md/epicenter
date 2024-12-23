import type { Result } from "./result";
import { Err, tryAsync, trySync } from "./result";

type ServiceErrorFns<ServiceErrorProperties> = {
	Err: (props: ServiceErrorProperties) => Err<ServiceErrorProperties>;
	trySync: <T>(opts: {
		try: () => T extends Promise<unknown> ? never : T;
		catch: (error: unknown) => ServiceErrorProperties;
	}) => Result<T, ServiceErrorProperties>;
	tryAsync: <T>(opts: {
		try: () => Promise<T>;
		catch: (error: unknown) => ServiceErrorProperties;
	}) => Promise<Result<T, ServiceErrorProperties>>;
};

export const createServiceErrorFns = <
	ServiceErrorProperties extends Record<string, unknown>,
>(): ServiceErrorFns<ServiceErrorProperties> => ({
	Err,
	trySync,
	tryAsync,
});

export type QueryFn<I, O, ServiceErrorProperties> = (
	input: I,
) => Promise<Result<O, ServiceErrorProperties>>;

export type MutationFn<I, O, ServiceErrorProperties> = (
	input: I,
	callbacks?: {
		onMutate?: (input: I) => Promise<void> | void;
		onSuccess?: (output: O, input: I) => Promise<void> | void;
		onError?: (error: ServiceErrorProperties, input: I) => Promise<void> | void;
		onSettled?: (
			output: O | undefined,
			error: ServiceErrorProperties | null,
			input: I,
		) => Promise<void> | void;
	},
) => Promise<void>;
