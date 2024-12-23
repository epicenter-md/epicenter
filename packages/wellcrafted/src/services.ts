import type { Result } from "./result";
import { Err, tryAsync, trySync } from "./result";

export type ServiceFn<I, O, ServiceErrorProperties> = (
	input: I,
) => Promise<Result<O, ServiceErrorProperties>>;

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
