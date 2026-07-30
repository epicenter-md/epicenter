# HTTP Boundaries

Hono handlers own the wire contract. Preserve the route's existing response shape instead of forcing every handler through one Result pattern.

## Typed Result Envelope

For routes whose contract is a serialized wellcrafted Result, mint a typed error and use its established status mapping. A codebase may keep status on the variant or in an exhaustive sibling map; follow the surface that already owns the protocol.

```ts
const error = BlobError.NotFound();
return c.json(error, error.error.status);
```

The factory returns the full `{ data: null, error }` envelope. Do not wrap it in another `Err`.

## Protocol-Specific Error Shape

Some routes implement an external protocol, such as an OpenAI-compatible API. Return that protocol's stable error envelope and status. A direct `try-catch` is appropriate when the handler immediately converts a transport exception into the required response.

```ts
let upstream: Response;
try {
	upstream = await fetch(endpoint, request);
} catch (cause) {
	log.warn(GatewayError.UpstreamUnreachable({ cause }));
	return c.json(openAiError('The provider could not be reached.', 'upstream_unreachable'), 502);
}
```

Do not expose `extractErrorMessage(cause)` on a public wire unless that protocol explicitly promises raw provider detail. Log the typed internal failure and return stable client-facing copy.

## Map Known Exceptions, Rethrow Bugs

External SDKs often throw known operational errors alongside ordinary programming errors. Convert only the known family:

```ts
function callProvider<T>(fn: () => Promise<T>): Promise<Result<T, BillingError>> {
	return tryAsync({
		try: fn,
		catch: (cause) => {
			if (!isProviderError(cause)) throw cause;
			return BillingError.ProviderRequestFailed();
		},
	});
}
```

The same rule applies in a routed Hono sub-app's `onError` boundary. A throw from the sub-app handler reaches the parent app's error handler:

```ts
const providerRoutes = new Hono();
providerRoutes.onError((cause, c) => {
	if (!isProviderError(cause)) throw cause;
	return c.json(BillingError.ProviderRequestFailed(), 503);
});
parentApp.route('/provider', providerRoutes);
```

This keeps an expected provider outage branchable while allowing a `TypeError` or invariant violation to reach the parent app's real 500 boundary. Do not teach this as a root-app pattern: rethrowing from the root app's own `onError` escapes Hono rather than invoking another Hono handler.

## Handler Checklist

1. Identify the wire contract before choosing Result or exception control flow.
2. Reuse the surface's established error envelope and status mapping.
3. Translate only exceptions the boundary can classify honestly.
4. Keep internal causes in typed errors and logs, not public response text.
5. Rethrow unknown failures only when a real outer boundary owns them.
