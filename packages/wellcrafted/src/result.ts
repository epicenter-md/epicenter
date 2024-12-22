export type Ok<T> = {
	ok: true;
	data: T;
};
export type Err<E> = {
	ok: false;
	error: E;
};
export type Result<T, E> = Ok<T> | Err<E>;

export const Ok = <T>(data: T): Ok<T> => ({ ok: true, data });
export const Err = <E>(error: E): Err<E> => ({ ok: false, error });

export function trySync<T, E>({
	try: operation,
	catch: mapError,
}: {
	try: () => T extends Promise<unknown> ? never : T;
	catch: (error: unknown) => E;
}): Result<T, E> {
	try {
		const data = operation();
		return Ok(data);
	} catch (error) {
		return Err(mapError(error));
	}
}

export async function tryAsync<T, E>({
	try: operation,
	catch: mapError,
}: {
	try: () => Promise<T>;
	catch: (error: unknown) => E;
}): Promise<Result<T, E>> {
	try {
		const data = await operation();
		return Ok(data);
	} catch (error) {
		return Err(mapError(error));
	}
}
