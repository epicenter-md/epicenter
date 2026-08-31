# Derive Types Before You Declare Them

A new named type is guilty until proven useful. Before declaring one, ask a boring question: does this shape already belong to an external library, a schema, a factory return value, a constant, or a function signature?

This is the smell:

```typescript
type OAuthPayload = {
	sub?: unknown;
};

const payload = await verifyAccessToken(token, options);
const userId = typeof payload.sub === 'string' ? payload.sub : null;
```

It looks harmless. It is also a tiny fork of someone else's contract. Better Auth owns that payload shape, and the local type will drift the moment the library tightens, renames, or documents another field.

Pull the type from the owner instead:

```typescript
import type { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client';

type VerifyOAuthAccessToken = ReturnType<
	ReturnType<typeof oauthProviderResourceClient>['getActions']
>['verifyAccessToken'];
```

Now the local boundary follows the actual verifier we call. If Better Auth changes the verifier contract, TypeScript points at the real mismatch instead of letting a hand-written `OAuthPayload` keep lying.

## Schemas Should Own Data Shapes

If a shape crosses a runtime boundary, a bare TypeScript type is usually not enough. The runtime parser should be the source of truth, and the TypeScript type should follow it.

```typescript
export const AuthUser = type({
	id: 'string',
	createdAt: 'string',
	updatedAt: 'string',
	email: 'string',
	emailVerified: 'boolean',
	name: 'string',
	'image?': 'string | null | undefined',
});

export type AuthUser = typeof AuthUser.infer;
```

That pattern gives you one definition. The parser rejects bad input, and the inferred type tells callers what survived parsing.

Composition works the same way. If `BearerSession` is just identity plus a token, say that in the schema instead of repeating the identity fields:

```typescript
export const AuthIdentity = type({
	user: AuthUser,
	encryptionKeys: EncryptionKeys,
});

export type AuthIdentity = typeof AuthIdentity.infer;

export const BearerSession = type({
	'...': AuthIdentity,
	token: 'string',
});

export type BearerSession = typeof BearerSession.infer;
```

The type relationship now matches the domain relationship. A bearer session contains an auth identity; it is not a second hand-written copy of user plus keys.

## Derive What Is Computed, Declare What You Supply

"Derive first" asks who owns the shape, and sometimes the answer is you. A branded primitive is the case where it is:

```typescript
// Computed: derive it. Stating this by hand duplicates every field.
export const AuthUser = type({ id: UserId, email: 'string' });
export type AuthUser = typeof AuthUser.infer;

// Supplied: state it. The validator is annotated to the type, not the reverse.
export type UserId = string & Brand<'UserId'>;
export const UserId = type('string').as<UserId>();
```

`Brand<'UserId'>` is a symbol that appears nowhere in `type('string')`. Arktype cannot compute it; you hand it in through the type argument. Writing `typeof UserId.infer` reads back the exact type you just supplied, and phrases it as though the validator knew something you did not. It also loses the alias in every hover downstream.

So the question is not "is this a brand or a schema." It is **does the type appear as a type argument you typed?** If it does, declare it and annotate the validator to it. If arktype worked it out, from fields or from a morph's return type, derive it.

See [Same Name for Type and Value](./same-name-for-type-and-value.md).

## Factories Should Own Handles

When a `create*` function returns an object, the returned object is often the best documentation for the public handle.

```typescript
export type AuthStateStore = ReturnType<typeof createAuthStateStore>;

export function createAuthStateStore(initialState: AuthState) {
	let state = initialState;
	const listeners = new Set<(state: AuthState) => void>();

	return {
		get state() {
			return state;
		},
		setState(next: AuthState) {
			state = next;
			for (const listener of listeners) listener(next);
		},
		onStateChange(fn: (state: AuthState) => void) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
	};
}
```

A separate object type would make readers jump away from the implementation to learn the same shape twice. Deriving the type keeps the name while making the factory the source of truth.

## Function Signatures Can Carry Local Helper Types

Small aliases are not automatically clearer. If a type exists only to name one parameter bag, it may be a speed bump.

```typescript
export async function resolveOAuthIdentity({
	authorization,
	verifyOAuthAccessToken,
	findUserById,
}: {
	authorization: string | null;
	verifyOAuthAccessToken: VerifyOAuthAccessToken;
	findUserById(userId: string): Promise<User | null>;
}) {
	// ...
}
```

This is easier to audit than a one-use `ResolveOAuthIdentityConfig` hidden above the function. The function is the boundary; the signature can carry the shape.

## Contracts Are Allowed To Be Named

The rule is not "never write types." The rule is "do not write types by reflex."

Keep the explicit type when the name is the contract:

```typescript
export type AuthClient = {
	state: AuthState;
	onStateChange(fn: (state: AuthState) => void): () => void;
	signOut(): Promise<Result<undefined, AuthError>>;
	fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
};
```

`AuthClient` earns its name because multiple runtimes implement it and consumers import it as the package contract. It is not a copy of one factory's return shape; it is the shared surface those factories agree to satisfy.

The same exception applies to protocol vocabulary, discriminated result unions, capability ports, and public package APIs. Those types are not duplication. They are the thing callers are depending on.

## The Practical Review Question

When you see a new named type in a diff, ask where the shape really lives.

```txt
External library owns it? Import it.
Runtime schema owns it? Infer it.
Factory owns it? ReturnType it.
Constant owns it? typeof it.
Function owns it? Parameters it, ReturnType it, or inline it.
Package boundary owns it? Name it.
```

The best type is usually not the cleverest one. It is the one with the fewest sources of truth.
