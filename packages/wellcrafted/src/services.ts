import type { Err, Ok, Result } from "./result";

type ServiceResultFactoryFns<ErrProps extends Record<string, unknown>> = {
	Ok: <T>(data: T) => Ok<T>;
	Err: <Props extends ErrProps>(props: Props) => Err<ErrProps>;
	Result: <T>(data: T) => Result<T, ErrProps>;
	trySync: <T>(opts: {
		try: () => T;
		catch: (error: unknown) => ErrProps;
	}) => Result<T, ErrProps>;
	tryAsync: <T>(opts: {
		try: () => Promise<T>;
		catch: (error: unknown) => ErrProps;
	}) => Promise<Result<T, ErrProps>>;
};

export function createServiceResultFactoryFns<
	ErrorProps extends Record<string, unknown>,
>(_errorType?: ErrorProps): ServiceResultFactoryFns<ErrorProps> {
	return {
		Ok: (data) => ({ ok: true, data }),
		Err: (props) => ({ ok: false, error: props }),
		Result: (data) => ({ ok: true, data }),
		trySync: ({ try: tryFn, catch: catchFn }) => {
			try {
				return { ok: true, data: tryFn() };
			} catch (error) {
				return { ok: false, error: catchFn(error) };
			}
		},
		tryAsync: async ({ try: tryFn, catch: catchFn }) => {
			try {
				return { ok: true, data: await tryFn() };
			} catch (error) {
				return { ok: false, error: catchFn(error) };
			}
		},
	};
}

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
