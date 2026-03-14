# Same Name for Type and Value

TypeScript has two parallel namespaces: one for types, one for values. Most people treat this as a quirk. It's actually one of the language's best features.

```typescript
export type FileId = Guid & Brand<'FileId'>;
export const FileId = type('string').as<FileId>();
```

`FileId` here is two things at once. In type position it's a branded string. In value position it's an arktype schema that validates and brands at runtime. Same name, zero ambiguity, because TypeScript resolves which one you mean from context.

## The Hover Effect

Here's the underrated part. When you hover over `FileId` in your IDE—whether you're looking at the type annotation or the const—you get the same JSDoc. TypeScript merges them. Write a JSDoc block on the type, and consumers see it everywhere the name appears: in function signatures, in schema definitions, in imports.

```typescript
/**
 * Device-scoped composite tab ID: `${deviceId}_${tabId}`.
 *
 * Prevents accidental mixing with plain strings, window IDs, or group IDs.
 */
export type TabCompositeId = string & Brand<'TabCompositeId'>;
export const TabCompositeId = type('string').as<TabCompositeId>();
```

Hover over `TabCompositeId` anywhere in the codebase and you'll see that doc comment. Whether it's used as a type annotation on a function parameter, or as a runtime schema passed into `defineTable`—same hover, same docs.

This matters more than it sounds. In a large codebase, discoverability is everything. When a colleague sees `windowId: WindowCompositeId` in a function signature, they hover it, they understand what it is, and they know what to pass. No grepping, no documentation site, no Slack messages.

## The Naming Tax

Zod's API nudges you into separate names:

```typescript
const userSchema = z.object({ name: z.string(), age: z.number() });
type User = z.infer<typeof userSchema>;
```

The schema is `userSchema`. The type is `User`. Two names for one concept. This creates a naming tax on every schema in your codebase: you decide between `userSchema`, `UserSchema`, `userValidator`, or just `User` (which shadows the type in some contexts). The Zod community has [debated this extensively](https://github.com/colinhacks/zod/discussions/929) with no consensus.

Zod's `z.infer<typeof userSchema>` also means the type is always _derived_ from the schema. You can't start from the type. The schema is the source of truth; the type is second-class.

ArkType's design [explicitly encourages](https://arktype.io/docs/faq) same-name PascalCase for entity types. The type and the runtime validator are peers, resolved by context. You can use the schema directly inside other arktype definitions:

```typescript
const tabs = defineTable(
	type({
		id: TabCompositeId, // ← this is the const (runtime schema)
		windowId: WindowCompositeId,
		groupId: GroupCompositeId,
	}),
);

type Tab = InferTableRow<typeof tabs>;
// Tab.id is TabCompositeId      ← this is the type (branded string)
// Tab.windowId is WindowCompositeId
```

One name flows through the entire system: schema definition, type inference, function signatures, IDE hovers. No `tabCompositeIdSchema` anywhere.

## The Pattern in Practice

We use this across the codebase for different purposes.

### Shadowed type with a constructor function

The simplest form is a branded type with a same-named constructor function. The constructor does the branding and any validation:

```typescript
/**
 * Unique identifier that cannot contain ':' characters.
 *
 * Used as a primary key across the system. The ':' restriction
 * allows safe use in composite keys like `${namespace}:${id}`.
 */
export type Id = string & Brand<'Id'>;
export function Id(value: string): Id {
	if (value.includes(':')) {
		throw new Error(`Id cannot contain ':': "${value}"`);
	}
	return value as Id;
}
```

The JSDoc on the type surfaces everywhere—in function signatures, hover tooltips, and import completions. The function provides runtime construction with the same name. When someone writes `Id('abc')`, the return type is `Id`, the hover shows the docs, and there's nothing else to name.

### Shadowed type with a validator + separate constructor

Sometimes the value-side name is taken by a schema validator (for deserialization, table definitions, etc.), but you also need a constructor that does real work—accepting component parts and assembling the final value. In that case, use a `createType` function alongside the shadowed pair:

````typescript
/**
 * Device-scoped composite tab ID: `${deviceId}_${tabId}`.
 *
 * Prevents accidental mixing with plain strings, window IDs, or group IDs.
 */
export type TabCompositeId = string & Brand<'TabCompositeId'>;
export const TabCompositeId = type('string').as<TabCompositeId>();

/**
 * Create a device-scoped composite tab ID from its parts.
 *
 * @example
 * ```typescript
 * const id = createTabCompositeId(deviceId, 123);
 * tables.tabs.delete(createTabCompositeId(deviceId, tabId));
 * ```
 */
export function createTabCompositeId(
	deviceId: string,
	tabId: number,
): TabCompositeId {
	return `${deviceId}_${tabId}` as TabCompositeId;
}
````

Here `TabCompositeId` (the type) and `TabCompositeId` (the const) handle the two-namespace pattern—the type brands your strings, the const validates them in schema definitions. `createTabCompositeId` is the constructor that does real work: it takes the component parts and joins them. The `create` prefix makes intent obvious at call sites.

This three-part split arises when the validator and the constructor have different jobs. The validator says "this string is already a `TabCompositeId`" (deserialization from Y.Doc). The constructor says "build me a new one from these parts." They don't collapse into one function because they serve different callers.
### Shadowed type with a validator + generator

The variant for IDs generated from scratch. The validator handles deserialization (Y.Doc reads), the generator wraps `generateId()` so the double-cast lives in exactly one place:

````typescript
export type SavedTabId = Id & Brand<'SavedTabId'>;
export const SavedTabId = type('string').as<SavedTabId>();

export const generateSavedTabId = (): SavedTabId =>
  generateId() as SavedTabId;
````

Three parts, three jobs. The type brands the string. The const validates it in `defineTable()` schemas. The generator creates new ones. Call sites just write `generateSavedTabId()`—no casts, no imports of `generateId`.

The `generate` prefix distinguishes these from `create` factories that compose from parts (like `createTabCompositeId(deviceId, tabId)`). `generate` means "new ID from scratch"; `create` means "assemble from inputs."


### Companion object

A richer form is a companion object with utility methods:

```typescript
export type DateTimeString = `${DateIsoString}|${TimezoneId}` &
	Brand<'DateTimeString'>;
export const DateTimeString = {
	is(value: unknown): value is DateTimeString {
		/* ... */
	},
	parse(str: DateTimeString): Temporal.ZonedDateTime {
		/* ... */
	},
	stringify(dt: Temporal.ZonedDateTime): DateTimeString {
		/* ... */
	},
	now(timezone?: string): DateTimeString {
		/* ... */
	},
} as const;
```

### Summary

| Variant                 | Type Side                                | Value Side                                         | Constructor                          |
| ----------------------- | ---------------------------------------- | -------------------------------------------------- | ------------------------------------ |
| Constructor function    | `type Id = string & Brand<'Id'>`         | `function Id(s: string): Id`                       | Same as value side                   |
| Validator + constructor | `type TabCompositeId = ... & Brand<...>` | `const TabCompositeId = type('string').as<…>()`    | `function createTabCompositeId(...)` |
| Validator + generator  | `type SavedTabId = Id & Brand<…>`        | `const SavedTabId = type('string').as<…>()` | `const generateSavedTabId = () => …`  |
| Companion object        | `type DateTimeString = ... & Brand<...>` | `const DateTimeString = { parse, stringify, now }` | Methods on the companion             |

## When Not to Do This

The pattern doesn't work when you need both the type and the value in the same expression. You can't write `const x: FileId = FileId` and mean "the type is FileId and the value is the FileId schema." TypeScript figures it out, but it can get confusing if both appear in the same line.

It also doesn't help for types that don't have a natural runtime counterpart. A `Result<T, E>` union type doesn't need a same-named const. The pattern shines specifically for types that have a 1:1 runtime representation: branded primitives, validated schemas, companion utilities.

## The Takeaway

If you're naming your schema `fooSchema` and your type `Foo`, you're paying a naming tax on every abstraction. TypeScript already solved this—types and values can share a name because they live in different namespaces. ArkType leans into this by design. The result is one name that works everywhere: type annotations, runtime validation, schema composition, and IDE hovers all showing the same docs.
