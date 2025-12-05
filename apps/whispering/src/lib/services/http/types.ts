import type { StandardSchemaV1 } from '@standard-schema/spec';
import { createTaggedError } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

/**
 * Network-level connection failure that prevents the HTTP request from reaching the server.
 *
 * Occurs when there are connectivity issues before any HTTP response is received.
 * Common causes: no internet, DNS failures, server unreachable, timeouts, CORS blocks.
 *
 * @example
 * ```typescript
 * // Network down, bad URL, or server unreachable
 * const result = await httpService.post({ url: 'https://down-server.com/api', ... });
 * // Result: ConnectionError
 * ```
 */
export const { ConnectionError, ConnectionErr } =
	createTaggedError('ConnectionError');
type ConnectionError = ReturnType<typeof ConnectionError>;

/**
 * HTTP response with a non-2xx status code (4xx client errors, 5xx server errors).
 *
 * The server received and processed the request but returned an error status.
 * Check the `status` property and response body for details.
 *
 * @example
 * ```typescript
 * // Bad auth, missing resource, or server error
 * const result = await httpService.post({ url: '/protected-endpoint', ... });
 * // Result: ResponseError with status: 401, 404, 500, etc.
 * ```
 */
const { ResponseError: ResponseErrorBase, ResponseErr: ResponseErrBase } =
	createTaggedError('ResponseError');
export type ResponseError = ReturnType<typeof ResponseErrorBase> & {
	/** HTTP status code (e.g., 400, 401, 404, 500) */
	status: number;
};
export const ResponseError = (args: Omit<ResponseError, 'name'>) => ({
	...ResponseErrorBase(args),
	status: args.status,
});
export const ResponseErr = (args: Omit<ResponseError, 'name'>) => ({
	data: null,
	error: ResponseError(args),
});

/**
 * Failed to parse the response body as valid JSON or validate against the schema.
 *
 * Server returned 2xx status but the response body is malformed JSON or doesn't match
 * the expected schema structure/types.
 *
 * @example
 * ```typescript
 * // Server returns "{ invalid json }" or { id: "string" } when expecting { id: number }
 * const result = await httpService.post({ schema: z.object({ id: z.number() }), ... });
 * // Result: ParseError
 * ```
 */
export const { ParseError, ParseErr } = createTaggedError('ParseError');
export type ParseError = ReturnType<typeof ParseError>;

export type HttpServiceError = ConnectionError | ResponseError | ParseError;

export type HttpService = {
	/**
	 * Makes a POST request with automatic JSON parsing and schema validation.
	 *
	 * Accepts any schema that implements the StandardSchemaV1 interface (Zod, Valibot, ArkType, etc.)
	 *
	 * **Error Handling Strategy:**
	 * 1. **Connection Phase:** Catches network-level failures (ConnectionError)
	 * 2. **Response Phase:** Validates HTTP status codes (ResponseError)
	 * 3. **Parse Phase:** Validates JSON structure and schema (ParseError)
	 */
	post: <TSchema extends StandardSchemaV1>(config: {
		url: string;
		body: BodyInit | FormData;
		schema: TSchema;
		headers?: Record<string, string>;
	}) => Promise<
		Result<StandardSchemaV1.InferOutput<TSchema>, HttpServiceError>
	>;
};
