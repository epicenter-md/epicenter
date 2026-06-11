# Two Type Utilities Every TypeScript Codebase Should Have

The most useful pair of types I've added to a TypeScript project is `Expect` and `Equal`. Together, they let you assert that two types are exactly the same. And if they're not, the build fails. No runtime cost, no test runner, just a red squiggly in your editor the moment something drifts.

## Rolling your own

You don't need a library. These two types come from Matt Pocock's [Total TypeScript](https://www.totaltypescript.com/how-to-test-your-types#rolling-your-own):

```typescript
type Expect<T extends true> = T;
type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
		? true
		: false;
```

`Expect` constrains its input to `true`. If you hand it `false`, TypeScript complains. That's it.

`Equal` is the clever one. It wraps both types inside a generic function signature, `<T>() => T extends X ? 1 : 2`, and checks whether the two signatures are identical. This forces TypeScript to compare types for identity rather than assignability. `string` extends `string | number`, but they aren't equal. `any` extends everything, but it isn't equal to `string`. The function trick catches both.

You use them together:

```typescript
type _Check = Expect<Equal<ActualType, ExpectedType>>;
```

If the types match, this is inert. If they don't, the build breaks with `Type 'false' does not satisfy the constraint 'true'`.

## Where this gets useful

Any time you're keeping two type definitions in sync, whether across files, across layers, or across package boundaries, `Expect<Equal<>>` acts as a tripwire.

The case that pushed me to add it: we store third-party data as `unknown[]` in a CRDT and cast it back to the library's type on read. The cast always compiles, even if the library changed the type in a new version. So we write down what we expect and check it against reality:

```typescript
type TanStackMessagePart = UIMessage['parts'][number];

type ExpectedPartTypes =
	| 'text'
	| 'image'
	| 'audio'
	| 'video'
	| 'document'
	| 'tool-call'
	| 'tool-result'
	| 'thinking';

type _DriftCheck = Expect<
	Equal<TanStackMessagePart['type'], ExpectedPartTypes>
>;
```

If the library adds `'file'` or drops `'thinking'`, the build fails before we ship. One line replaces what used to take four:

```typescript
// before: bidirectional extends + dummy variable + void
type _AExtendsB = Actual extends Expected ? true : never;
type _BExtendsA = Expected extends Actual ? true : never;
const _driftCheck: [_AExtendsB, _BExtendsA] = [true, true];
void _driftCheck;
```

The old approach also has a subtle bug: bidirectional `extends` can't distinguish `any` from concrete types, and it mishandles distributive conditionals. `Equal` doesn't have those problems.

This pattern isn't limited to third-party drift. It works anywhere two things need to stay in sync: a Zod schema's inferred type matching a manually written interface, a serialization format matching a domain type, or a database row type matching an API response shape. Drop the assertion next to the boundary and the compiler keeps them honest.
