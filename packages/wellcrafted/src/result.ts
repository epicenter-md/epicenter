export type Ok<T> = {
	ok: true;
	data: T;
};

export type Err<E> = {
	ok: false;
	error: E;
};

export type Result<T, E> = Ok<T> | Err<E>;

export type InferOk<R extends Result<unknown, unknown>> = R extends Ok<infer U>
	? U
	: never;

export type InferErr<R extends Result<unknown, unknown>> = R extends Err<
	infer U
>
	? U
	: never;

export const Ok = <T>(data: T): Ok<T> => ({ ok: true, data });
export const Err = <E>(error: E): Err<E> => ({ ok: false, error });

export function trySync<T, E>({
	try: operation,
	mapErr,
}: {
	try: () => T extends Promise<unknown> ? never : T;
	mapErr: (error: unknown) => E;
}): Result<T, E> {
	try {
		const data = operation();
		return Ok(data);
	} catch (error) {
		return Err(mapErr(error));
	}
}

export async function tryAsync<T, E>({
	try: operation,
	mapErr,
}: {
	try: () => Promise<T>;
	mapErr: (error: unknown) => E;
}): Promise<Result<T, E>> {
	try {
		const data = await operation();
		return Ok(data);
	} catch (error) {
		return Err(mapErr(error));
	}
}
