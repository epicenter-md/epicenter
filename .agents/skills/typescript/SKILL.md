---
name: typescript
description: TypeScript code style, type co-location, naming conventions (including acronym casing), test organization, and arktype patterns. Use when writing TypeScript code, defining types, naming variables/functions, organizing tests, or working with arktype schemas.
metadata:
  author: epicenter
  version: '1.0'
---

# TypeScript Guidelines

> **Related Skills**: See `arktype` for runtime type validation patterns. See `typebox` for TypeBox schema patterns. See `testing` for test file conventions.
## Core Rules

- Always use `type` instead of `interface` in TypeScript.
- **`readonly` only for arrays and maps**: Never use `readonly` on primitive properties or object properties. The modifier is shallow and provides little protection for non-collection types. Use it only where mutation is a realistic footgun:

  ```typescript
  // Good - readonly only on the array
  type Config = {
  	version: number;
  	vendor: string;
  	items: readonly string[];
  };

  // Bad - readonly everywhere is noise
  type Config = {
  	readonly version: number;
  	readonly vendor: string;
  	readonly items: readonly string[];
  };
  ```

  Exception: Match upstream library types exactly (e.g., standard-schema interfaces). See `docs/articles/readonly-is-mostly-noise.md` for rationale.

- **Acronyms in camelCase**: Treat acronyms as single words, capitalizing only the first letter:

  ```typescript
  // Correct - acronyms as words
  parseUrl();
  defineKv();
  readJson();
  customerId;
  httpClient;

  // Incorrect - all-caps acronyms
  parseURL();
  defineKV();
  readJSON();
  customerID;
  HTTPClient;
  ```

  Exception: Match existing platform APIs (e.g., `XMLHttpRequest`). See `docs/articles/acronyms-in-camelcase.md` for rationale.

- TypeScript 5.5+ automatically infers type predicates in `.filter()` callbacks. Don't add manual type assertions:

  ```typescript
  // Good - TypeScript infers the narrowed type automatically
  const filtered = items.filter((x) => x !== undefined);

  // Bad - unnecessary type predicate
  const filtered = items.filter(
  	(x): x is NonNullable<typeof x> => x !== undefined,
  );
  ```

- When moving components to new locations, always update relative imports to absolute imports (e.g., change `import Component from '../Component.svelte'` to `import Component from '$lib/components/Component.svelte'`)
- When functions are only used in the return statement of a factory/creator function, use object method shorthand syntax instead of defining them separately. For example, instead of:
  ```typescript
  function myFunction() {
  	const helper = () => {
  		/* ... */
  	};
  	return { helper };
  }
  ```
  Use:
  ```typescript
  function myFunction() {
  	return {
  		helper() {
  			/* ... */
  		},
  	};
  }
  ```
- **Prefer factory functions over classes**: Use `function createX() { return { ... } }` instead of `class X { ... }`. Closures provide structural privacy—everything above the return statement is private by position, everything inside it is the public API. Classes mix `private`/`protected`/public members in arbitrary order, forcing you to scan every member and check its modifier. See `docs/articles/closures-are-better-privacy-than-keywords.md` for rationale.


## Switch Over If/Else for Value Comparison

When multiple `if`/`else if` branches compare the same variable against string literals (or other constant values), always use a `switch` statement instead. This applies to action types, status fields, file types, strategy names, or any discriminated value.

```typescript
// Bad - if/else chain comparing the same variable
if (change.action === 'add') {
	handleAdd(change);
} else if (change.action === 'update') {
	handleUpdate(change);
} else if (change.action === 'delete') {
	handleDelete(change);
}

// Good - switch statement
switch (change.action) {
	case 'add':
		handleAdd(change);
		break;
	case 'update':
		handleUpdate(change);
		break;
	case 'delete':
		handleDelete(change);
		break;
}
```

Use fall-through for cases that share logic:

```typescript
switch (change.action) {
	case 'add':
	case 'update': {
		applyChange(change);
		break;
	}
	case 'delete': {
		removeChange(change);
		break;
	}
}
```

Use block scoping (`{ }`) when a case declares variables with `let` or `const`.

When NOT to use switch: early returns for type narrowing are fine as sequential `if` statements. If each branch returns immediately and the checks are narrowing a union type for subsequent code, keep them as `if` guards.

See `docs/articles/switch-over-if-else-for-value-comparison.md` for rationale.

## Record Lookup Over Nested Ternaries

When an expression maps a finite set of known values to outputs, use a `satisfies Record` lookup instead of nested ternaries. This is the expression-level counterpart to "Switch Over If/Else": switch handles statements with side effects, record lookup handles value mappings.

```typescript
// Bad - nested ternary
const tooltip = status === 'connected'
	? 'Connected'
	: status === 'connecting'
		? 'Connecting…'
		: 'Offline';

// Good - record lookup with exhaustive type checking
const tooltip = ({
	connected: 'Connected',
	connecting: 'Connecting…',
	offline: 'Offline',
} satisfies Record<SyncStatus, string>)[status];
```

`satisfies Record<SyncStatus, string>` gives you compile-time exhaustiveness: if `SyncStatus` gains a fourth value, TypeScript errors because the record is missing a key. Nested ternaries silently fall through to the else branch.

`as const` is unnecessary here. `satisfies` already validates the shape and value types. `as const` would narrow values to literal types (`'Connected'` instead of `string`), which adds no value when the output is just rendered or passed as a string.

When the record is used once, inline it. When it's shared or has 5+ entries, extract to a named constant.

See `docs/articles/record-lookup-over-nested-ternaries.md` for rationale.

# Type Co-location Principles

## Never Use Generic Type Buckets

Don't create generic type files like `$lib/types/models.ts`. This creates unclear dependencies and makes code harder to maintain.

### Bad Pattern

```typescript
// $lib/types/models.ts - Generic bucket for unrelated types
export type LocalModelConfig = { ... };
export type UserModel = { ... };
export type SessionModel = { ... };
```

### Good Pattern

```typescript
// $lib/services/transcription/local/types.ts - Co-located with service
export type LocalModelConfig = { ... };

// $lib/services/user/types.ts - Co-located with user service
export type UserModel = { ... };
```

## Co-location Rules

1. **Service-specific types**: Place in `[service-folder]/types.ts`
2. **Component-specific types**: Define directly in the component file
3. **Shared domain types**: Place in the domain folder's `types.ts`
4. **Cross-domain types**: Only if truly shared across multiple domains, place in `$lib/types/[specific-name].ts`

## `types.ts` Is A Code Smell (Prefer Computed Types Over Manual Declarations)

When a type can be derived from a runtime value, derive it. Don't declare it manually in a separate file.

```typescript
// Good — type is computed from the runtime definition
export const BROWSER_TABLES = { devices, tabs, windows };
export type Tab = InferTableRow<typeof BROWSER_TABLES.tabs>;

// Good — type is derived from schema
const userSchema = z.object({ id: z.string(), email: z.string() });
type User = z.infer<typeof userSchema>;

// Bad — manually declaring what already exists as a runtime value
// types.ts
export type Tab = { id: string; deviceId: string /* ... */ };
```

If every type in a `types.ts` can be derived with `typeof`, `z.infer`, `InferTableRow`, `ReturnType`, etc., the file is redundant. Put each type next to the runtime value it's computed from.

# Constant Array Naming Conventions

## Pattern Summary

| Pattern                         | Suffix                 | Description             | Example                                  |
| ------------------------------- | ---------------------- | ----------------------- | ---------------------------------------- |
| Simple values (source of truth) | Plural noun with unit  | Raw values array        | `BITRATES_KBPS`, `SAMPLE_RATES`          |
| Rich array (source of truth)    | Plural noun            | Contains all metadata   | `PROVIDERS`, `RECORDING_MODE_OPTIONS`    |
| IDs only (for validation)       | `_IDS`                 | Derived from rich array | `PROVIDER_IDS`                           |
| UI options `{value, label}`     | `_OPTIONS`             | For dropdowns/selects   | `BITRATE_OPTIONS`, `SAMPLE_RATE_OPTIONS` |
| Label map                       | `_TO_LABEL` (singular) | `Record<Id, string>`    | `LANGUAGES_TO_LABEL`                     |

## When to Use Each Pattern

### Pattern 1: Simple Values -> Derived Options

Use when the label can be computed from the value:

```typescript
// constants/audio/bitrate.ts
export const BITRATES_KBPS = ['16', '32', '64', '128'] as const;

export const BITRATE_OPTIONS = BITRATES_KBPS.map((bitrate) => ({
	value: bitrate,
	label: `${bitrate} kbps`,
}));
```

### Pattern 2: Simple Values + Metadata Object

Use when labels need richer information than the value alone:

```typescript
// constants/audio/sample-rate.ts
export const SAMPLE_RATES = ['16000', '44100', '48000'] as const;

const SAMPLE_RATE_METADATA: Record<
	SampleRate,
	{ shortLabel: string; description: string }
> = {
	'16000': { shortLabel: '16 kHz', description: 'Optimized for speech' },
	'44100': { shortLabel: '44.1 kHz', description: 'CD quality' },
	'48000': { shortLabel: '48 kHz', description: 'Studio quality' },
};

export const SAMPLE_RATE_OPTIONS = SAMPLE_RATES.map((rate) => ({
	value: rate,
	label: `${SAMPLE_RATE_METADATA[rate].shortLabel} - ${SAMPLE_RATE_METADATA[rate].description}`,
}));
```

### Pattern 3: Rich Array as Source of Truth

Use when options have extra fields beyond `value`/`label` (e.g., `icon`, `desktopOnly`):

```typescript
// constants/audio/recording-modes.ts
export const RECORDING_MODES = ['manual', 'vad', 'upload'] as const;
export type RecordingMode = (typeof RECORDING_MODES)[number];

export const RECORDING_MODE_OPTIONS = [
	{ label: 'Manual', value: 'manual', icon: 'mic', desktopOnly: false },
	{
		label: 'Voice Activated',
		value: 'vad',
		icon: 'mic-voice',
		desktopOnly: false,
	},
	{ label: 'Upload File', value: 'upload', icon: 'upload', desktopOnly: false },
] as const satisfies {
	label: string;
	value: RecordingMode;
	icon: string;
	desktopOnly: boolean;
}[];

// Derive IDs for validation if needed
export const RECORDING_MODE_IDS = RECORDING_MODE_OPTIONS.map((o) => o.value);
```

## Choosing a Pattern

| Scenario                                                          | Pattern                  |
| ----------------------------------------------------------------- | ------------------------ |
| Label = formatted value (e.g., "128 kbps")                        | Simple Values -> Derived |
| Label needs separate data (e.g., "16 kHz - Optimized for speech") | Values + Metadata        |
| Options have extra UI fields (icon, description, disabled)        | Rich Array               |
| Platform-specific or runtime-conditional content                  | Keep inline in component |

## Naming Rules

### Source Arrays

- Use **plural noun**: `PROVIDERS`, `MODES`, `LANGUAGES`
- Add unit suffix when relevant: `BITRATES_KBPS`, `SAMPLE_RATES`
- Avoid redundant `_VALUES` suffix

### Derived/Options Arrays

- Use **plural noun** + `_OPTIONS` suffix: `BITRATE_OPTIONS`, `SAMPLE_RATE_OPTIONS`
- For IDs: **plural noun** + `_IDS` suffix: `PROVIDER_IDS`

### Label Maps

- Use **singular** `_TO_LABEL` suffix: `LANGUAGES_TO_LABEL`
- Describes the operation (id -> label), not the container
- Reads naturally: `LANGUAGES_TO_LABEL[lang]` = "get the label for this language"

### Constant Casing

- Always use `SCREAMING_SNAKE_CASE` for exported constants
- Never use `camelCase` for constant objects/arrays

## Co-location

Options arrays should be co-located with their source array in the same file. Avoid creating options inline in Svelte components; import pre-defined options instead.

Exception: Keep options inline when they have platform-specific or runtime-conditional content that would require importing platform constants into the data module.

# Parameter Destructuring for Factory Functions

## Prefer Parameter Destructuring Over Body Destructuring

When writing factory functions that take options objects, destructure directly in the function signature instead of in the function body. This is the established pattern in the codebase.

### Bad Pattern (Body Destructuring)

```typescript
// DON'T: Extra line of ceremony
function createSomething(opts: { foo: string; bar?: number }) {
	const { foo, bar = 10 } = opts; // Unnecessary extra line
	return { foo, bar };
}
```

### Good Pattern (Parameter Destructuring)

```typescript
// DO: Destructure directly in parameters
function createSomething({ foo, bar = 10 }: { foo: string; bar?: number }) {
	return { foo, bar };
}
```

### Why This Matters

1. **Fewer lines**: Removes the extra destructuring statement
2. **Defaults at API boundary**: Users see defaults in the signature, not hidden in the body
3. **Works with `const` generics**: TypeScript literal inference works correctly:
   ```typescript
   function select<const TOptions extends readonly string[]>({
     options,
     nullable = false,
   }: {
     options: TOptions;
     nullable?: boolean;
   }) { ... }
   ```
4. **Closures work identically**: Inner functions capture the same variables either way

### When Body Destructuring is Valid

- Need to distinguish "property missing" vs "property is `undefined`" (`'key' in opts`)
- Complex normalization/validation of the options object
- Need to pass the entire `opts` object to other functions

### Codebase Examples

```typescript
// From packages/epicenter/src/core/schema/columns.ts
export function select<const TOptions extends readonly [string, ...string[]]>({
  options,
  nullable = false,
  default: defaultValue,
}: {
  options: TOptions;
  nullable?: boolean;
  default?: TOptions[number];
}): SelectColumnSchema<TOptions, boolean> {
  return { type: 'select', nullable, options, default: defaultValue };
}

// From apps/whispering/.../create-key-recorder.svelte.ts
export function createKeyRecorder({
  pressedKeys,
  onRegister,
  onClear,
}: {
  pressedKeys: PressedKeys;
  onRegister: (keyCombination: KeyboardEventSupportedKey[]) => void;
  onClear: () => void;
}) { ... }
```

# Arktype Optional Properties

## Never Use `| undefined` for Optional Properties

When defining optional properties in arktype schemas, always use the `'key?'` syntax instead of `| undefined` unions. This is critical for JSON Schema conversion (used by OpenAPI/MCP).

### Bad Pattern

```typescript
// DON'T: Explicit undefined union - breaks JSON Schema conversion
const schema = type({
	window_id: 'string | undefined',
	url: 'string | undefined',
});
```

This produces invalid JSON Schema with `anyOf: [{type: "string"}, {}]` because `undefined` has no JSON Schema equivalent.

### Good Pattern

```typescript
// DO: Optional property syntax - converts cleanly to JSON Schema
const schema = type({
	'window_id?': 'string',
	'url?': 'string',
});
```

This correctly omits properties from the `required` array in JSON Schema.

### Why This Matters

| Syntax                       | TypeScript Behavior                        | JSON Schema                     |
| ---------------------------- | ------------------------------------------ | ------------------------------- |
| `key: 'string \| undefined'` | Required prop, accepts string or undefined | Broken (triggers fallback)      |
| `'key?': 'string'`           | Optional prop, accepts string              | Clean (omitted from `required`) |

Both behave similarly in TypeScript, but only the `?` syntax converts correctly to JSON Schema for OpenAPI documentation and MCP tool schemas.

# Inline Definitions in Tests

## Prefer Inlining Single-Use Definitions

When a schema, builder, or configuration is only used once in a test, inline it directly at the call site rather than extracting to a variable.

### Bad Pattern (Extracted Variables)

```typescript
test('creates workspace with tables', () => {
	const posts = defineTable(type({ id: 'string', title: 'string', _v: '1' }));

	const theme = defineKv(type("'light' | 'dark'"), 'light');

	const workspace = defineWorkspace({
		id: 'test-app',
		tables: { posts },
		kv: { theme },
	});

	expect(workspace.id).toBe('test-app');
});
```

### Good Pattern (Inlined)

```typescript
test('creates workspace with tables', () => {
	const workspace = defineWorkspace({
		id: 'test-app',
		tables: {
			posts: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
		},
		kv: {
			theme: defineKv(type("'light' | 'dark'"), 'light'),
		},
	});

	expect(workspace.id).toBe('test-app');
});
```

### Why Inlining is Better

1. **All context in one place**: No scrolling to understand what `posts` or `theme` are
2. **Reduces naming overhead**: No need to invent variable names for single-use values
3. **Matches mental model**: The definition IS the usage - they're one conceptual unit
4. **Easier to copy/modify**: Self-contained test setup is easier to duplicate and tweak

### When to Extract

Extract to a variable when:

- The value is used **multiple times** in the same test
- You need to call **methods on the result** (e.g., `posts.migrate()`, `posts.versions`)
- The definition is **shared across multiple tests** in a `beforeEach` or test fixture
- The inline version would exceed ~15-20 lines and hurt readability

### Applies To

- `defineTable()`, `defineKv()`, `defineWorkspace()` builders
- `createTables()`, `createKV()` factory calls
- Schema definitions (arktype, zod, etc.)
- Configuration objects passed to factories
- Mock functions used only once

# Test File Organization

## Shadow Source Files with Test Files

Each source file should have a corresponding test file in the same directory:

```
src/static/
├── schema-union.ts
├── schema-union.test.ts      # Tests for schema-union.ts
├── define-table.ts
├── define-table.test.ts      # Tests for define-table.ts
├── create-tables.ts
├── create-tables.test.ts     # Tests for create-tables.ts
└── types.ts                  # No test file (pure types)
```

### Benefits

- **Clear ownership**: Each test file tests exactly one source file
- **Easy navigation**: Find tests by looking next to the source
- **Focused testing**: Easier to run tests for just one module
- **Maintainability**: When source changes, you know which test file to update

### What Gets Test Files

| File Type                      | Test File? | Reason                                |
| ------------------------------ | ---------- | ------------------------------------- |
| Functions/classes with logic   | Yes        | Has behavior to test                  |
| Type definitions only          | No         | No runtime behavior                   |
| Re-export barrels (`index.ts`) | No         | Just re-exports, tested via consumers |
| Internal helpers               | Maybe      | Test via consumer if tightly coupled  |

### Naming Convention

- Source: `foo-bar.ts`
- Test: `foo-bar.test.ts`

### Integration Tests

For tests spanning multiple modules, either:

- Add to the test file of the highest-level consumer
- Create a dedicated `[feature].integration.test.ts` if substantial

# Branded Types Pattern

## Use Brand Constructors, Never Raw Type Assertions

When working with branded types (nominal typing), always create a brand constructor function. Never use `as BrandedType` assertions scattered throughout the codebase.

### Bad Pattern (Scattered Assertions)

```typescript
// types.ts
type RowId = string & Brand<'RowId'>;

// file1.ts
const id = someString as RowId; // Bad: assertion here

// file2.ts
function getRow(id: string) {
	doSomething(id as RowId); // Bad: another assertion
}

// file3.ts
const parsed = key.split(':')[0] as RowId; // Bad: assertions everywhere
```

### Good Pattern (Brand Constructor)

```typescript
// types.ts
import type { Brand } from 'wellcrafted/brand';

type RowId = string & Brand<'RowId'>;

// Brand constructor - THE ONLY place with `as RowId`
// Uses PascalCase to match the type name (avoids parameter shadowing)
function RowId(id: string): RowId {
	return id as RowId;
}

// file1.ts
const id = RowId(someString); // Good: uses constructor

// file2.ts
function getRow(rowId: string) {
	doSomething(RowId(rowId)); // Good: no shadowing issues
}

// file3.ts
const parsed = RowId(key.split(':')[0]); // Good: consistent
```

### Why Brand Constructors Are Better

1. **Single source of truth**: Only one place has the type assertion
2. **Future validation**: Easy to add runtime validation later
3. **Searchable**: `RowId(` is easy to find and audit
4. **Explicit boundaries**: Clear where unbranded -> branded conversion happens
5. **Refactor-safe**: Change the branding logic in one place
6. **No shadowing**: PascalCase constructor doesn't shadow camelCase parameters

### Implementation Pattern

```typescript
import type { Brand } from 'wellcrafted/brand';

// 1. Define the branded type
export type RowId = string & Brand<'RowId'>;

// 2. Create the brand constructor (only `as` assertion in codebase)
// PascalCase matches the type - TypeScript allows same-name type + value
export function RowId(id: string): RowId {
	return id as RowId;
}

// 3. Optionally add validation
export function RowId(id: string): RowId {
	if (id.includes(':')) {
		throw new Error(`RowId cannot contain ':': ${id}`);
	}
	return id as RowId;
}
```

### Naming Convention

| Branded Type   | Constructor Function |
| -------------- | -------------------- |
| `RowId`        | `RowId()`            |
| `FieldId`      | `FieldId()`          |
| `UserId`       | `UserId()`           |
| `DocumentGuid` | `DocumentGuid()`     |

The constructor uses **PascalCase matching the type name**. TypeScript allows a type and value to share the same name (different namespaces). This avoids parameter shadowing issues.

### When Functions Accept Branded Types

If a function requires a branded type, callers must use the brand constructor:

```typescript
// Function requires branded RowId
function getRow(id: RowId): Row { ... }

// Caller must brand the string - no shadowing since RowId() is PascalCase
function processRow(rowId: string) {
  getRow(RowId(rowId));  // rowId param doesn't shadow RowId() function
}
```

This makes type boundaries visible and intentional, without forcing awkward parameter renames.

### Branded IDs for Workspace Tables

Every `defineTable()` schema MUST use branded ID types for the `id` field and all string foreign keys. Never use plain `'string'` for table IDs.

For tables that use arktype schemas, follow the three-part pattern:

```typescript
// 1. TYPE — extends Id, not string (enables single-cast in generator)
export type SavedTabId = Id & Brand<'SavedTabId'>;

// 2. VALIDATOR — zero-cost type assertion for schema composition
export const SavedTabId = type('string').as<SavedTabId>();

// 3. GENERATOR — wraps generateId() so the cast lives in one place
export const generateSavedTabId = (): SavedTabId =>
	generateId() as SavedTabId;
```

Use directly in the schema: `id: SavedTabId` and for optional FKs: `'parentId?': SavedTabId.or('undefined')`.

At call sites, use the generator—never the double-cast:

```typescript
// Good
const id = generateSavedTabId();

// Bad — scattered casts
const id = generateId() as string as SavedTabId;
```

The `generate*` prefix means "new ID from scratch." The `create*` prefix means "assemble from inputs" (e.g., `createTabCompositeId(deviceId, tabId)`).

Not every branded type needs all three parts. `DeviceId` is set from an external source (no generator). Path types like `AbsolutePath` need only the type.

See the `workspace-api` skill for the full workspace file structure and rules.

# Extract Coupled `let` State Into Sub-Factories

When a factory function accumulates `let` statements that are always read, written, and reset together, extract them into a sub-factory. The tell: two or three `let` declarations that move as a pack across multiple inner functions.

## The Smell

```typescript
function createProvider(config) {
  let retries = 0;
  let reconnectSleeper: Sleeper | null = null;

  async function runLoop() {
    // ... 5-line backoff ceremony using retries + reconnectSleeper ...
    // ... appears in TWO places ...
  }

  function handleOnline() {
    reconnectSleeper?.wake(); // reaches into closure state
  }

  function handleSuccess() {
    retries = 0; // reset scattered across the function
  }
}
```

`retries` and `reconnectSleeper` are one concept ("backoff") split across two `let` declarations, two inline ceremonies, and one external poke.

## The Fix

Pull coupled state into its own factory with named methods:

```typescript
function createBackoff() {
  let retries = 0;
  let sleeper: { promise: Promise<void>; wake(): void } | null = null;

  return {
    async sleep() { /* compute delay, create sleeper, await, cleanup */ },
    wake() { sleeper?.wake(); },
    reset() { retries = 0; },
  };
}
```

The parent factory replaces scattered `let` manipulation with named calls:

```typescript
function createProvider(config) {
  const backoff = createBackoff();

  async function runLoop() {
    await backoff.sleep();     // was 5 duplicated lines
  }

  function handleOnline() {
    backoff.wake();            // was reconnectSleeper?.wake()
  }

  function handleSuccess() {
    backoff.reset();           // was retries = 0
  }
}
```

## When to Extract

| Signal | Action |
|---|---|
| Two+ `let`s always set in the same function | Likely one concept |
| Resetting one requires resetting the others | Definitely one concept |
| An external caller reaches into one of them | The concept needs a public API |
| The same multi-line ceremony appears twice | Extract and name it |

## When NOT to Extract

Don't extract `let` state that's deeply woven into control flow branching. If the variables are the loop's decision-making state (e.g., `desired`, `runId`, `connectRun` in a supervisor loop), extracting them just renames the complexity without reducing it. The test: do the call sites get simpler?

See `docs/articles/let-packs-are-factories-waiting-to-be-named.md` for a full walkthrough with three extractions from a real sync provider.

# Const Generic Array Inference

Use `const T extends readonly T[]` to preserve literal types without requiring `as const` at call sites.

| Pattern                             | Plain `['a','b','c']`      | With `as const`            |
| ----------------------------------- | -------------------------- | -------------------------- |
| `T extends string[]`                | `string[]`                 | `["a", "b", "c"]`          |
| `T extends readonly string[]`       | `string[]`                 | `readonly ["a", "b", "c"]` |
| `const T extends string[]`          | `["a", "b", "c"]`          | `["a", "b", "c"]`          |
| `const T extends readonly string[]` | `readonly ["a", "b", "c"]` | `readonly ["a", "b", "c"]` |

The `const` modifier preserves literal types; the `readonly` constraint determines mutability.

```typescript
// From packages/epicenter/src/core/schema/fields/factories.ts
export function select<const TOptions extends readonly [string, ...string[]]>({
	id,
	options,
}: {
	id: string;
	options: TOptions;
}): SelectField<TOptions> {
	// ...
}

// Caller gets literal union type — no `as const` needed
const status = select({ id: 'status', options: ['draft', 'published'] });
// status.options[number] is "draft" | "published", not string
```

See `docs/articles/typescript-const-modifier-generic-type-parameters.md` for details.
